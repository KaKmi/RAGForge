import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { PromptNode, ReleaseCheckIssue } from "@codecrush/contracts";
import { RELEASE_CHECK_JOB, RELEASE_CHECK_QUEUE } from "../../platform/queue/queue.constants";
import type { Queue } from "../../platform/queue/queue.port";
import { NodeRuntimeService } from "../node-runtime/executor/node-runtime.service";
import { PromptsService } from "../prompts/prompts.service";
import { ApplicationsRepository } from "./applications.repository";
import { buildSamples } from "./release-check.samples";
import type { ApplicationConfigVersionRow } from "./schema";

const RELEASE_CHECK_TTL_MS = 15 * 60 * 1000; // 通过后 15 分钟有效（009）
const ZOMBIE_MS = 15 * 60 * 1000; // running 超过此窗口视为僵尸，允许重跑（对齐 ingestion）

const NODES = ["rewrite", "intent", "reply", "fallback"] as const;
const NODE_COLUMNS: Record<PromptNode, { prompt: keyof ApplicationConfigVersionRow }> = {
  rewrite: { prompt: "promptRewriteVersionId" },
  intent: { prompt: "promptIntentVersionId" },
  reply: { prompt: "promptReplyVersionId" },
  fallback: { prompt: "promptFallbackVersionId" },
};
const MODEL_COLUMNS: Record<PromptNode, keyof ApplicationConfigVersionRow> = {
  rewrite: "rewriteModelId",
  intent: "intentModelId",
  reply: "replyModelId",
  fallback: "fallbackModelId",
};

// M7b ReleaseCheck 第二层：异步真实 NodeRuntime 预演（抄 ingestion.processor 的 OnModuleInit+subscribe 范式）。
@Injectable()
export class ReleaseCheckProcessor implements OnModuleInit {
  private readonly logger = new Logger(ReleaseCheckProcessor.name);

  constructor(
    @Inject(RELEASE_CHECK_QUEUE) private readonly queue: Queue,
    private readonly repo: ApplicationsRepository,
    private readonly nodeRuntime: NodeRuntimeService,
    private readonly prompts: PromptsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.subscribe(RELEASE_CHECK_JOB, async (data) => {
      await this.process((data as { checkId: string }).checkId);
    });
  }

  async process(checkId: string): Promise<void> {
    const check = await this.repo.findReleaseCheckById(checkId);
    if (!check) return;
    // 幂等/僵尸守卫：终态跳过；running 未超时跳过；running 超时或 queued 才跑
    if (check.status === "passed" || check.status === "failed" || check.status === "expired") return;
    if (
      check.status === "running" &&
      check.startedAt &&
      Date.now() - check.startedAt.getTime() < ZOMBIE_MS
    )
      return;

    await this.repo.markReleaseCheckRunning(checkId);
    const version = await this.repo.findVersionById(check.configVersionId);
    if (!version) {
      await this.repo.markReleaseCheckResult(checkId, {
        status: "failed",
        issues: [{ code: "VERSION_MISSING", message: "配置版本不存在" }],
        sampleSummary: {},
        expiresAt: null,
      });
      return;
    }
    // 冒烟预演的候选路由 = 应用固定的 kbIds（intent 越权校验用）
    const availableRoutes = await this.repo.findVersionKbIds(version.id);

    const issues: ReleaseCheckIssue[] = [];
    const summary: Record<string, { ok: number; total: number }> = {};
    let allOk = true;

    for (const node of NODES) {
      const promptVersionId = version[NODE_COLUMNS[node].prompt] as string;
      const modelId = version[MODEL_COLUMNS[node]] as string;
      const exec = await this.prompts.getVersionExecutable(promptVersionId);
      if (!exec) {
        allOk = false;
        summary[node] = { ok: 0, total: 0 };
        issues.push({ code: "PROMPT_VERSION_MISSING", node, promptVersionId, message: `${node} 的 PromptVersion 不存在` });
        continue;
      }
      const params = version.nodeParams[node];
      const samples = buildSamples(node, availableRoutes);
      const result = await this.nodeRuntime.compileAndSample({
        node,
        contractVersion: exec.contractVersion,
        promptVersionId,
        promptBody: exec.body,
        modelId,
        modelParams: { temperature: params.temperature, topP: params.topP },
        samples,
      });
      const okCount = result.results.filter((r) => r.ok).length;
      summary[node] = { ok: okCount, total: result.results.length };
      if (!result.ok) {
        allOk = false;
        for (const r of result.results.filter((s) => !s.ok)) {
          issues.push({
            code: r.issues[0]?.code ?? "SAMPLE_FAILED",
            node,
            promptVersionId,
            sampleIndex: r.sampleIndex,
            traceId: r.traceId,
            action: "OPEN_PROMPT_TRY_RUN",
            message: r.issues[0]?.message ?? `${node} 样例 ${r.sampleIndex} 预演未通过`,
          });
        }
      }
    }

    await this.repo.markReleaseCheckResult(checkId, {
      status: allOk ? "passed" : "failed",
      issues,
      sampleSummary: summary,
      expiresAt: allOk ? new Date(Date.now() + RELEASE_CHECK_TTL_MS) : null,
    });
    this.logger.log(`release check ${checkId} → ${allOk ? "passed" : "failed"}`);
  }
}
