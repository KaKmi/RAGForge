import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type {
  CreateEvalRunRequest,
  EvalMetricKey,
  EvalRunListItem,
  EvalRunReport,
  EvalRunScorecard,
  EvalRunResult,
  EvalRunSkippedCase,
  EvalRunStatus,
  EvalVerdict,
  RecentEvalRunConflict,
} from "@codecrush/contracts";
import { EVAL_RUN_JOB, EVAL_RUN_QUEUE } from "../../platform/queue/queue.constants";
import type { Queue } from "../../platform/queue/queue.port";
import { ApplicationsService } from "../applications/applications.service";
import {
  EVAL_RUN_IDEMPOTENCY_MS,
  EVAL_RUN_JOB_RETRY_LIMIT,
  EVAL_RUN_METRIC_KEYS,
} from "./eval-run.constants";
import { EvalSetsRepository } from "./eval-sets.repository";
import {
  EvalRunsRepository,
  type EvalRunAggregate,
  type EvalRunResultWithCase,
} from "./eval-runs.repository";
import type { EvalRunSnapshotEntry } from "./schema";

/** 配置版本解析不到时（应用被软删等）的标签退化值——报告本身仍要能打开。 */
const UNRESOLVED_VERSION_LABEL = "—";

/** 只有 startedAt+finishedAt 齐全才算耗时；运行中不猜（契约允许 null，原型只在终态显示耗时）。 */
function durationOf(row: EvalRunAggregate): number | null {
  if (!row.startedAt || !row.finishedAt) return null;
  return Math.max(0, row.finishedAt.getTime() - row.startedAt.getTime());
}

function toListItem(row: EvalRunAggregate, configVersionLabel: string): EvalRunListItem {
  return {
    id: row.id,
    setId: row.setId,
    setName: row.setName,
    applicationId: row.applicationId,
    configVersionId: row.configVersionId,
    configVersionLabel,
    // varchar → enum 的直接断言：DB 侧 `eval_runs_status_check` 已把值域钉死（同 eval-sets.service.ts:51）。
    status: row.status as EvalRunStatus,
    overallScore: row.overallScore,
    totalCases: row.totalCases,
    doneCases: row.doneCases,
    durationMs: durationOf(row),
    createdAt: row.createdAt.toISOString(),
  };
}

function toResult(row: EvalRunResultWithCase): EvalRunResult {
  return {
    seq: row.seq,
    caseId: row.caseId,
    caseVersion: row.caseVersion,
    question: row.question,
    faithfulness: row.faithfulness,
    answerRelevancy: row.answerRelevancy,
    contextPrecision: row.contextPrecision,
    correctness: row.correctness,
    minMetric: row.minMetric as EvalMetricKey | null,
    minScore: row.minScore,
    verdict: row.verdict as EvalVerdict,
    evidence: row.evidence as EvalRunResult["evidence"],
    previewTraceId: row.previewTraceId,
    answer: row.answer,
    durationMs: row.durationMs,
    error: row.error,
  };
}

/**
 * 单指标聚合：avg **只对非 NULL 样本**算（未评不进分母——原型 §6「不拉低均值」），
 * 并回传覆盖率。`total` = **实际跑到的用例数**（结果行数），不是快照总数：
 * 「没跑」由 `skippedCount` 单独表达，混进覆盖率会让「裁判挂了多少」读不出来。
 */
function metricAggregate(
  results: EvalRunResultWithCase[],
  key: (typeof EVAL_RUN_METRIC_KEYS)[number],
): EvalRunScorecard["retrieval"]["contextPrecision"] {
  const values = results.map((row) => row[key]).filter((value): value is number => value !== null);
  const sum = values.reduce((acc, value) => acc + value, 0);
  return {
    value: values.length > 0 ? Math.round(sum / values.length) : null,
    scoredCount: values.length,
    total: results.length,
  };
}

function buildScorecard(results: EvalRunResultWithCase[], skippedCount: number): EvalRunScorecard {
  const countOf = (verdict: EvalVerdict) => results.filter((row) => row.verdict === verdict).length;
  return {
    // W2a 检索层只有 contextPrecision；recall/ndcg/hitRate 需 gold docs 通路 → W2b（018 决策 E）。
    retrieval: { contextPrecision: metricAggregate(results, "contextPrecision") },
    generation: {
      faithfulness: metricAggregate(results, "faithfulness"),
      answerRelevancy: metricAggregate(results, "answerRelevancy"),
      correctness: metricAggregate(results, "correctness"),
    },
    passCount: countOf("pass"),
    weakCount: countOf("weak"),
    lowCount: countOf("low"),
    // timeout/unscored 不进 pass/weak/low 分母，但必须显性可见（018 已知取舍 2 的代价缓解：
    // 一个每条都超时的配置表现为「覆盖率 0%」而非低分，超时数不显眼就会被误读成「没测」）。
    timeoutCount: countOf("timeout"),
    unscoredCount: countOf("unscored"),
    skippedCount,
  };
}

/**
 * run 生命周期（发起 / 停止 / 查询）。**判分结果只落 Postgres**——绝不发 `rag.eval` span：
 * ClickHouse 的 `codecrush_eval_targets_mv` 只按 `SpanName='rag.eval'` 过滤、不看 preview，
 * 发了会立刻污染屏1 的在线三指标（018 决策 B）。
 */
@Injectable()
export class EvalRunsService {
  constructor(
    private readonly repo: EvalRunsRepository,
    private readonly sets: EvalSetsRepository,
    private readonly applications: ApplicationsService,
    @Inject(EVAL_RUN_QUEUE) private readonly queue: Queue,
  ) {}

  async list(): Promise<EvalRunListItem[]> {
    const rows = await this.repo.listAggregates();
    const labels = await this.versionLabels(rows);
    return rows.map((row) =>
      toListItem(row, labels.get(row.configVersionId) ?? UNRESOLVED_VERSION_LABEL),
    );
  }

  /**
   * 原型 §18.A 的发起守卫，逐条落地。校验顺序刻意如此：
   *  1. 评测集存活 —— 放在最前而非最后。`listReviewedCaseVersions` 已 join 过滤 `eval_sets.deleted_at`，
   *     软删集会吐空数组 → 若先查用例，用户会收到「所选范围没有已审核用例」这个**误导性**文案
   *     （集根本就不存在了，不是没审用例）。先查集 → 404，语义准确且不改变「软删集不可跑」的结论。
   *  2. ≥1 已审用例（§19.2 逐字文案）。
   *  3. 全局串行 → 409。
   *  4. 1h 幂等 → 409 `recent_run_exists`（force=true 跳过）。
   *  5. 配置版本可解析（§19.2 逐字文案）。**放在写库前**：先插行再发现版本不可用会留一条
   *     必然 failed 的 run，还占着全局串行位。
   */
  async create(req: CreateEvalRunRequest, actor: string): Promise<EvalRunListItem> {
    const set = await this.sets.findSetById(req.setId);
    if (!set) throw new NotFoundException("评测集不存在");

    const cases = await this.sets.listReviewedCaseVersions(req.setId);
    if (cases.length === 0) throw new UnprocessableEntityException("所选范围没有已审核用例"); // §19.2 逐字

    const active = await this.repo.findActiveRun();
    if (active) throw new ConflictException("已有评测正在运行，请等待完成或先停止");

    if (!req.force) {
      const since = new Date(Date.now() - EVAL_RUN_IDEMPOTENCY_MS);
      const recent = await this.repo.findRecentDoneRun(req.setId, req.configVersionId, since);
      if (recent) {
        // 原型 §19.2「1 小时内已有相同评测结果 · 查看 / 仍重新运行」——前端据 code 弹选择框。
        const body: RecentEvalRunConflict = { code: "recent_run_exists", recentRunId: recent.id };
        throw new ConflictException(body);
      }
    }

    // preview=true 的显式版本解析；停用/不存在都在这里抛。
    const cfg = await this.resolveConfig(req.applicationId, req.configVersionId, actor);

    const snapshot: EvalRunSnapshotEntry[] = cases.map((row) => ({
      caseId: row.caseId,
      caseVersionId: row.caseVersionId,
      seq: row.seq,
    }));
    const run = await this.repo.insertRun({
      setId: req.setId,
      applicationId: req.applicationId,
      configVersionId: req.configVersionId,
      judgeModelId: req.judgeModelId,
      embeddingModelId: req.embeddingModelId,
      caseVersionSnapshot: snapshot,
      totalCases: snapshot.length,
      createdBy: actor,
    });
    await this.queue.publish(
      EVAL_RUN_JOB,
      { runId: run.id },
      { retryLimit: EVAL_RUN_JOB_RETRY_LIMIT },
    );
    // 新 run 必然 0 结果 → 综合分直接给 null，省一次回读（同 eval-sets.service.ts:78-85 的做法）。
    return toListItem({ ...run, setName: set.name, overallScore: null }, `v${cfg.version}`);
  }

  async getReport(id: string): Promise<EvalRunReport> {
    const row = await this.repo.findAggregateById(id);
    if (!row) throw new NotFoundException("评测报告不存在");

    const labels = await this.versionLabels([row]);
    const results = await this.repo.listResults(id);
    const snapshot = row.caseVersionSnapshot as EvalRunSnapshotEntry[];
    const skipped = await this.deriveSkipped(snapshot, results);

    return {
      run: {
        ...toListItem(row, labels.get(row.configVersionId) ?? UNRESOLVED_VERSION_LABEL),
        judgeModelId: row.judgeModelId,
        offlineJudgeVersion: row.offlineJudgeVersion,
        tokenBudget: row.tokenBudget,
        tokensUsed: row.tokensUsed,
        startedAt: row.startedAt?.toISOString() ?? null,
        finishedAt: row.finishedAt?.toISOString() ?? null,
        error: row.error,
      },
      scorecard: buildScorecard(results, snapshot.length - results.length),
      results: results.map(toResult),
      skipped,
    };
  }

  /** 原型 §18.A：只有 queued/running 可停；终态 → 409（报告不可变）。 */
  async stop(id: string): Promise<void> {
    const run = await this.repo.findRunById(id);
    if (!run) throw new NotFoundException("评测不存在");
    if (run.status !== "queued" && run.status !== "running") {
      throw new ConflictException("该评测已结束，无法停止");
    }
    // 条件更新兜并发：查到 running、下一刻 worker 收尾成终态 → 这里返回 false，仍报 409。
    if (!(await this.repo.requestStop(id, new Date()))) {
      throw new ConflictException("该评测已结束，无法停止");
    }
  }

  /**
   * 未跑到的用例**不写结果行**（018 §10）→ skipped 由 `snapshot − 结果行` 推导，按 seq 排序。
   * 版本行不可变且永不删，理论上必能查到；查不到就跳过（宁可少一行也不吐半条脏数据）。
   */
  private async deriveSkipped(
    snapshot: EvalRunSnapshotEntry[],
    results: EvalRunResultWithCase[],
  ): Promise<EvalRunSkippedCase[]> {
    const recorded = new Set(results.map((row) => row.caseVersionId));
    const pending = snapshot
      .filter((entry) => !recorded.has(entry.caseVersionId))
      .sort((a, b) => a.seq - b.seq);
    if (pending.length === 0) return [];
    const versions = new Map(
      (await this.repo.findCaseVersionsByIds(pending.map((entry) => entry.caseVersionId))).map(
        (version) => [version.id, version],
      ),
    );
    return pending.flatMap((entry) => {
      const version = versions.get(entry.caseVersionId);
      if (!version) return [];
      return [
        {
          seq: entry.seq,
          caseId: entry.caseId,
          caseVersion: version.version,
          question: version.question,
        },
      ];
    });
  }

  private async resolveConfig(applicationId: string, configVersionId: string, actor: string) {
    try {
      return await this.applications.resolveForTest(applicationId, configVersionId, actor);
    } catch {
      throw new UnprocessableEntityException("该版本已不可用"); // §19.2 逐字
    }
  }

  /**
   * `eval_runs` 只存跨域 id（AGENTS.md 边界 5：不建跨域 FK），版本号要回 applications 域取。
   * 按 applicationId 去重批量取版本表，避免逐 run 一次调用；应用被软删 → `listVersions` 抛 404，
   * 吞掉并让标签退化为「—」（报告是历史存档，不该因应用没了就打不开）。
   */
  private async versionLabels(rows: EvalRunAggregate[]): Promise<Map<string, string>> {
    const labels = new Map<string, string>();
    for (const applicationId of new Set(rows.map((row) => row.applicationId))) {
      try {
        for (const version of await this.applications.listVersions(applicationId)) {
          labels.set(version.id, `v${version.version}`);
        }
      } catch {
        // 保持缺省 → UNRESOLVED_VERSION_LABEL
      }
    }
    return labels;
  }
}
