import { HttpException, Injectable, Logger } from "@nestjs/common";
import type { ChatStreamEvent, ReplayRequest, ReplayScoresEvent } from "@codecrush/contracts";
import { ApplicationsService } from "../applications/applications.service";
import { OrchestrationService } from "../chat/orchestration.service";
import { EvaluationJudgeService } from "../evaluations/evaluation-judge.service";
import { EvaluationsRepository } from "../evaluations/evaluations.repository";
import type { EvaluationContext } from "../evaluations/evaluation.types";

/** 重放即时判分只暴露 3 个基础指标（correctness 无 gold 不调、citation 不进重放面板）。 */
const REPLAY_EVIDENCE_KEYS = ["faithfulness", "answerRelevancy", "contextPrecision"] as const;

/**
 * E-W2b F7：单条重放。SSE 逐帧转发同编排（preview），流结束后若裁判配置齐 → 进程内即时判分，
 * 追发 `replay_scores` 帧。**分数不落任何存储、不发任何 span**（不变量 1）。
 *
 * 限频用内存 Map（单副本部署前提，019 Boundary 5）；60s 内同 sourceTraceId 重复 → 429。
 */
@Injectable()
export class ReplayService {
  private readonly logger = new Logger(ReplayService.name);
  private readonly lastReplayAt = new Map<string, number>();
  private static readonly RATE_LIMIT_MS = 60_000;

  constructor(
    private readonly orchestration: OrchestrationService,
    private readonly applications: ApplicationsService,
    private readonly judge: EvaluationJudgeService,
    private readonly evaluations: EvaluationsRepository,
  ) {}

  async *stream(
    req: ReplayRequest,
    actor: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamEvent | ReplayScoresEvent> {
    // 1) 限频（§19.2 逐字）。
    const now = Date.now();
    const last = this.lastReplayAt.get(req.sourceTraceId);
    if (last !== undefined && now - last < ReplayService.RATE_LIMIT_MS) {
      throw new HttpException("操作过于频繁，请 1 分钟后再试", 429);
    }
    this.lastReplayAt.set(req.sourceTraceId, now);

    // 2) 解析版本（停用/不存在 → 422，§19.1）。
    let cfg;
    try {
      cfg = await this.applications.resolveForTest(req.applicationId, req.configVersionId, actor);
    } catch {
      throw new HttpException("该版本已不可用", 422);
    }

    // 3) drain-and-relay：逐帧转发，累计答案、捕获 hits。
    let hits: EvaluationContext[] = [];
    let replyText = "";
    let hadError = false;
    const gen = this.orchestration.runForReplay(cfg, req.question, {
      signal,
      onPrep: (prep) => {
        hits = prep.hits;
      },
    });
    for await (const ev of gen) {
      if (ev.type === "token") replyText += ev.delta;
      else if (ev.type === "error") hadError = true;
      yield ev;
    }

    // 4) 即时判分：答案非空 && 无 error && 裁判配置齐 → 判分（goldPoints 空 → correctness 不调）。
    if (hadError || replyText.trim() === "") return;
    const settings = await this.evaluations.getSettings();
    if (!settings.judgeModelId || !settings.embeddingModelId) return; // 未配置 → 前端显示「未评」
    try {
      const scores = await this.judge.scoreOffline(
        { targetTraceId: "", question: req.question, answer: replyText, contexts: hits.slice(0, 20) },
        { judgeModelId: settings.judgeModelId, embeddingModelId: settings.embeddingModelId },
        [],
      );
      const evidence: ReplayScoresEvent["evidence"] = {};
      for (const key of REPLAY_EVIDENCE_KEYS) {
        if (scores.evidence[key]) evidence[key] = scores.evidence[key];
      }
      yield {
        type: "replay_scores",
        faithfulness: scores.faithfulness,
        answerRelevancy: scores.answerRelevancy,
        contextPrecision: scores.contextPrecision,
        evidence,
      };
    } catch (err) {
      // 重放判分是即时参考，失败不阻塞主流（帧已发完）。
      this.logger.warn(`重放判分失败（忽略）：${(err as Error).message}`);
    }
  }
}
