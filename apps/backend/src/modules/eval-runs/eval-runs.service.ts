import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type {
  CreateEvalRunRequest,
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
import type { EvalCompareResponse } from "@codecrush/contracts";
import { EVAL_RUN_IDEMPOTENCY_MS, EVAL_RUN_JOB_RETRY_LIMIT } from "./eval-run.constants";
import { aggregateResults } from "./eval-run-aggregate";
import { buildCompareResponse, type CompareRunInput } from "./eval-compare";
import { EvalSetsRepository } from "./eval-sets.repository";
import {
  EvalRunsRepository,
  isSingleActiveRunConflict,
  type EvalRunAggregate,
  type EvalRunResultWithCase,
} from "./eval-runs.repository";
import type { EvalRunSnapshotEntry } from "./schema";

/** 配置版本解析不到时（应用被软删等）的标签退化值——报告本身仍要能打开。 */
const UNRESOLVED_VERSION_LABEL = "—";

/** 只有 startedAt+finishedAt 齐全才算耗时；运行中不猜（契约允许 null，原型只在终态显示耗时）。 */
/**
 * 两个 run 是否「可比」：同一评测集 + 用例版本集合完全一致。
 *
 * B1/F5：抽成模块级纯函数供门禁复用——门禁不能另写一套可比性判据，
 * 否则会出现「对比页说不可比、门禁却给了结论」的自相矛盾。
 * 两个调用点对不可比的**反应**不同（compare() 抛 409；门禁降级为 NO_RUN 放行），
 * 但**判据**必须是同一个。
 */
export function isSameCaseSet(aRow: EvalRunAggregate, bRow: EvalRunAggregate): boolean {
  if (aRow.setId !== bRow.setId) return false;
  const aSet = new Set((aRow.caseVersionSnapshot as EvalRunSnapshotEntry[]).map((e) => e.caseVersionId));
  const bSet = new Set((bRow.caseVersionSnapshot as EvalRunSnapshotEntry[]).map((e) => e.caseVersionId));
  return aSet.size === bSet.size && [...aSet].every((id) => bSet.has(id));
}

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
    repeatCount: row.repeatCount,
    durationMs: durationOf(row),
    createdAt: row.createdAt.toISOString(),
  };
}

/** 记分卡指标键（8 项：4 argmin + citation + 3 检索 gold）。 */
type ScorecardMetricKey =
  | "faithfulness"
  | "answerRelevancy"
  | "contextPrecision"
  | "correctness"
  | "citation"
  | "contextRecall"
  | "ndcg5"
  | "hitRate5";

/**
 * 单指标聚合：avg **只对非 NULL 样本**算（未评不进分母——原型 §6「不拉低均值」），
 * 并回传覆盖率。`total` = **实际跑到的用例数**（聚合后的 case 行数，F5），不是快照总数：
 * 「没跑」由 `skippedCount` 单独表达，混进覆盖率会让「裁判挂了多少」读不出来。
 */
function metricAggregate(
  results: EvalRunResult[],
  key: ScorecardMetricKey,
): EvalRunScorecard["retrieval"]["contextPrecision"] {
  const values = results.map((row) => row[key]).filter((value): value is number => value !== null);
  const sum = values.reduce((acc, value) => acc + value, 0);
  return {
    value: values.length > 0 ? Math.round(sum / values.length) : null,
    scoredCount: values.length,
    total: results.length,
  };
}

function buildScorecard(
  results: EvalRunResult[],
  skippedCount: number,
  goldCoverage: { withGold: number; total: number },
): EvalRunScorecard {
  const countOf = (verdict: EvalVerdict) => results.filter((row) => row.verdict === verdict).length;
  return {
    // F2：检索层四指标。contextPrecision 是 LLM 判分；recall/ndcg5/hitRate5 是 gold 排序真值。
    retrieval: {
      contextPrecision: metricAggregate(results, "contextPrecision"),
      contextRecall: metricAggregate(results, "contextRecall"),
      ndcg5: metricAggregate(results, "ndcg5"),
      hitRate5: metricAggregate(results, "hitRate5"),
      goldCoverage,
    },
    generation: {
      faithfulness: metricAggregate(results, "faithfulness"),
      answerRelevancy: metricAggregate(results, "answerRelevancy"),
      correctness: metricAggregate(results, "correctness"),
      citation: metricAggregate(results, "citation"), // F4：仅记分卡，不进 verdict/综合分
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
  private readonly logger = new Logger(EvalRunsService.name);

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

    // 先回收僵尸 run，再查全局串行位：worker 进程被杀/OOM/掉电时，`finally` 的 releaseLease
    // 与 pg-boss 重试都不会发生，run 会永久卡在 `running` —— 而下面这道守卫把 running 一律
    // 视为「有活跃 run」→ **一次崩溃就把整个离线评测功能永久锁死**（此后每次发起都 409，
    // 只能人工改库）。回收判据是租约过期（worker 已逐条续租 → 过期严格等价于 worker 没了）。
    // 不架空 retryLimit: 3 靠的是 `EVAL_RUN_REAP_GRACE_MS` 宽限期，**不是**租约 TTL——
    // 异常路径上 pg-boss 的 retry_delay 默认为 0（立刻重试），比 5 分钟 TTL 快得多。
    const reaped = await this.repo.reapAbandonedRuns(new Date());
    if (reaped.length > 0) {
      this.logger.warn(`回收了 ${reaped.length} 条租约过期的僵尸 run：${reaped.join(", ")}`);
    }

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
    let run;
    try {
      run = await this.repo.insertRun({
        setId: req.setId,
        applicationId: req.applicationId,
        configVersionId: req.configVersionId,
        judgeModelId: req.judgeModelId,
        embeddingModelId: req.embeddingModelId,
        caseVersionSnapshot: snapshot,
        totalCases: snapshot.length,
        repeatCount: req.repeatCount,
        createdBy: actor,
      });
    } catch (err) {
      // 上面的 findActiveRun 是快速路径（给可读文案、省掉后续无用功），但它与本次
      // INSERT 之间无事务 —— 两个并发请求会双双越过它。唯一索引是原子兜底。
      // **抛同一条 ConflictException**：e2e 钉死了响应体，前端按形状分流。
      if (isSingleActiveRunConflict(err)) {
        throw new ConflictException("已有评测正在运行，请等待完成或先停止");
      }
      throw err;
    }
    // 入队失败必须把 run 收成 failed 再抛：插行与入队不在同一事务，publish 抛出会留下一条
    // **永远 queued 且没有任何 job 会来跑**的孤儿 run —— 而 queued 同样占着全局串行位，
    // stop() 也只置信号不改状态。
    //
    // 回收器**能**兜底：reapAbandonedRuns 有两条臂（running 看租约过期、queued 看
    // created_at 过期 **且** 无人持租，见 eval-runs.repository.ts 的 or(...)），所以
    // queued 孤儿最终会被收成 failed —— 不要据本段重复实现一遍回收。
    // 但它要等满一个 EVAL_RUN_REAP_GRACE_MS（15 分钟；该宽限期是 15(c) 的 deadline 锚点，
    // 存在的理由是「重试永远先于回收」，不可为了这里的手感调小）。发起侧没有理由把这 15
    // 分钟的全局串行位空窗甩给用户 —— 我们这里就知道 publish 挂了，当场收口即可。
    try {
      await this.queue.publish(
        EVAL_RUN_JOB,
        { runId: run.id },
        { retryLimit: EVAL_RUN_JOB_RETRY_LIMIT },
      );
    } catch (err) {
      // 收窄到「仍是无主 queued」：catch 只能证明 publish **抛出**，不能证明 job 没落库
      // （网络超时后服务端已收到是可达的）。若 worker 已接管，这里必须什么都不做。
      const finished = await this.repo.finishRunUnowned(
        run.id,
        "failed",
        new Date(),
        "入队失败，未能启动评测",
      );
      this.logger.error(
        `run ${run.id} 入队失败${finished ? "，已收成 failed" : "（已被 worker 接管，保持原状）"}：${(err as Error).message}`,
      );
      throw err;
    }
    // 新 run 必然 0 结果 → 综合分直接给 null，省一次回读（同 eval-sets.service.ts:78-85 的做法）。
    return toListItem({ ...run, setName: set.name, overallScore: null }, `v${cfg.version}`);
  }

  async getReport(id: string): Promise<EvalRunReport> {
    const row = await this.repo.findAggregateById(id);
    if (!row) throw new NotFoundException("评测报告不存在");

    const labels = await this.versionLabels([row]);
    const rawResults = await this.repo.listResults(id);
    const snapshot = row.caseVersionSnapshot as EvalRunSnapshotEntry[];
    // F5：按 caseVersionId 聚合多次重复 → 每 case 一行（顶层均值 + repeats 明细）。
    const results = aggregateResults(rawResults);
    const skipped = await this.deriveSkipped(snapshot, rawResults);
    // F2：goldCoverage 按**本 run 快照**用例的 goldDocRefs 非空数算（记分卡旁标「gold 38/50」）。
    const goldCoverage = await this.computeGoldCoverage(snapshot);

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
      // skippedCount = 快照 − 有 ≥1 行结果的 case 数（聚合后行数）。
      scorecard: buildScorecard(results, snapshot.length - results.length, goldCoverage),
      results,
      skipped,
    };
  }

  /** F8 屏4：两 run 对比。a/b 顺序即基线/候选（前端按 createdAt 排 a=旧 b=新）。 */
  async compare(aId: string, bId: string): Promise<EvalCompareResponse> {
    // a/b 两侧取数彼此独立，并行发出——串行会让本接口的延迟变成两次全量 listResults 之和。
    const [aRow, bRow] = await Promise.all([
      this.repo.findAggregateById(aId),
      this.repo.findAggregateById(bId),
    ]);
    if (!aRow || !bRow) throw new NotFoundException("评测报告不存在");

    const TERMINAL: EvalRunStatus[] = ["done", "partial", "budget_stop"];
    if (
      !TERMINAL.includes(aRow.status as EvalRunStatus) ||
      !TERMINAL.includes(bRow.status as EvalRunStatus)
    ) {
      throw new ConflictException("运行未结束，无法对比");
    }

    if (!isSameCaseSet(aRow, bRow)) {
      // §19.2：前端据 body.code 渲染红条「结论不可比」。
      throw new ConflictException({ code: "incomparable" });
    }

    const [aInput, bInput] = await this.loadCompareInputs(aRow, bRow);
    return buildCompareResponse(aInput, bInput);
  }

  /**
   * B1/F5：把 compare() 原先内联的「两侧取数」抽出来，供**上线门禁**复用。
   *
   * 刻意不在这里做终态/可比性校验——compare() 有自己的 4xx 语义（NotFound/Conflict），
   * 门禁则必须 fail-open（异常一律降级成 warning issue，绝不拦发布）。两种错误语义
   * 不能塞进同一个函数，故校验留在各自调用点，**取数只此一份**（口径分叉就是下一个 bug）。
   */
  async loadCompareInputs(
    aRow: EvalRunAggregate,
    bRow: EvalRunAggregate,
  ): Promise<[CompareRunInput, CompareRunInput]> {
    const labels = await this.versionLabels([aRow, bRow]);
    const toInput = async (row: EvalRunAggregate): Promise<CompareRunInput> => ({
      summary: {
        ...toListItem(row, labels.get(row.configVersionId) ?? UNRESOLVED_VERSION_LABEL),
        judgeModelId: row.judgeModelId,
        offlineJudgeVersion: row.offlineJudgeVersion,
        tokensUsed: row.tokensUsed,
      },
      results: aggregateResults(await this.repo.listResults(row.id)),
    });
    // a/b 两侧取数彼此独立，并行发出。
    return await Promise.all([toInput(aRow), toInput(bRow)]);
  }

  /** F2：本 run 快照里 goldDocRefs 非空的用例数（withGold）/ 快照总数（total）。 */
  private async computeGoldCoverage(
    snapshot: EvalRunSnapshotEntry[],
  ): Promise<{ withGold: number; total: number }> {
    if (snapshot.length === 0) return { withGold: 0, total: 0 };
    const versions = await this.repo.findCaseVersionsByIds(
      snapshot.map((entry) => entry.caseVersionId),
    );
    const withGold = versions.filter((v) => v.goldDocRefs.length > 0).length;
    return { withGold, total: snapshot.length };
  }

  /**
   * B2b 屏3 行尾「标记忽略」（原型 `:322`）。薄转发——这是**叠加标志**，
   * 不改任何分数/verdict/记分卡口径，故没有状态机可校验。
   *
   * 不做「行不存在 → 404」：`ignored_at` 是幂等的置位/清位，对已忽略的行再标一次、
   * 或对没有结果行的 case（未跑到）标一次，语义都是「标完了，现在就是这个状态」。
   * 为此额外查一次只会换来一个既贵又能被并发绕过的断言。
   *
   * **代价说清楚**：一个合法 UUID 但在本 run 里没有任何结果行的 caseId（陈旧标签页、
   * run 已删、或直接调 API），会得到 204 + 前端一句「已标记忽略」，而重拉后那行并没有标记——
   * 一个被 UI 打脸的成功提示。当前 UI 走不到这条路（未跑到的行不渲染操作菜单，有测试钉着），
   * 故接受；若将来这个端点被别处复用，要重新掂量。
   */
  async setResultIgnored(
    runId: string,
    caseId: string,
    ignored: boolean,
    now = new Date(),
  ): Promise<void> {
    await this.repo.setResultIgnored(runId, caseId, ignored, now);
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
