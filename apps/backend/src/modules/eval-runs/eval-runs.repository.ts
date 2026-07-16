import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { DRIZZLE } from "../../platform/persistence/drizzle.constants";
import type { DB } from "../../platform/persistence/persistence.module";
import {
  evalCaseVersions,
  evalRunResults,
  evalRuns,
  evalSets,
  type EvalRunResultRow,
  type EvalRunRow,
  type EvalRunSnapshotEntry,
} from "./schema";

export interface NewEvalRunInput {
  setId: string;
  applicationId: string;
  configVersionId: string;
  judgeModelId: string;
  embeddingModelId: string;
  caseVersionSnapshot: EvalRunSnapshotEntry[];
  totalCases: number;
  createdBy: string;
}

/** run 行 + 只有 DB 算得出的两项（集名走同域 join；综合分见下方 `OVERALL_SCORE` 口径）。 */
export type EvalRunAggregate = EvalRunRow & {
  setName: string;
  overallScore: number | null;
};

/** 结果行 + 用例版本的展示字段（报告的 # / 问题 / 版本列）。 */
export type EvalRunResultWithCase = EvalRunResultRow & {
  caseId: string;
  caseVersion: number;
  question: string;
};

/** 快照里的用例版本内容（worker 逐条跑时要问题与 gold；报告推导 skipped 时要问题）。 */
export interface EvalCaseVersionContent {
  id: string;
  caseId: string;
  version: number;
  question: string;
  goldPoints: string[];
}

export interface NewEvalRunResultInput {
  runId: string;
  caseVersionId: string;
  seq: number;
  verdict: string;
  faithfulness: number | null;
  answerRelevancy: number | null;
  contextPrecision: number | null;
  correctness: number | null;
  minMetric: string | null;
  minScore: number | null;
  evidence: Record<string, string[]>;
  previewTraceId: string | null;
  answer: string;
  tokensUsed: number;
  durationMs: number;
  error: string | null;
}

/**
 * 综合分（`EvalRunListItem.overallScore`）—— **必须与屏2「上次得分」逐字同口径**：
 * 每个指标先按非 NULL 样本求 AVG（AVG 天然忽略 NULL），再对**评出来的**指标求均值，
 * 四舍五入到一位小数；四指标全 NULL → NULL，**绝不退化成 0**。
 *
 * 这段表达式与 `eval-sets.repository.ts` 的 `SET_AGG_SELECT.lastRunScore`（:92-109）
 * **逐字同形**，差别只在选 run 的方式：那边是「该集最近一个终态 run」的子查询，这边是
 * 当前行 `"eval_runs"."id"`。因此屏2 展示某集的 lastRunScore、屏3 展示同一个 run 的
 * overallScore 时，两者是 PG 对**同一批行**跑**同一段 SQL** → 数值必然一致。
 *
 * ⚠️ 刻意没有抽成共享常量：`eval-sets.repository.ts` 属其他 story 的已交付代码，本 story
 * 的文件范围明令不得改动。两处口径若将来要改，**必须同时改**（见 story-6 report 的收口建议）。
 * 同理不可改用 TS 侧求均值：TS float64 与 PG numeric 的舍入边界不保证逐位一致，
 * 而「屏2 与屏3 不许对不上」是本波的硬不变量。
 *
 * 注意 drizzle 的 `sql` 模板把 `${evalRuns.id}` 渲染成未限定的 `"id"`，在相关子查询里会被
 * 内层表抢解析 —— 外层引用必须显式写 `"eval_runs"."id"`（同 eval-sets.repository.ts:60-61 的坑）。
 */
const OVERALL_SCORE = sql<number | null>`(
  SELECT ROUND(AVG(m.v)::numeric, 1)::float8
  FROM (
    SELECT AVG(res.faithfulness) AS f,
           AVG(res.answer_relevancy) AS r,
           AVG(res.context_precision) AS p,
           AVG(res.correctness) AS c
    FROM "eval_run_results" res
    WHERE res.run_id = "eval_runs"."id"
  ) agg
  CROSS JOIN LATERAL unnest(ARRAY[agg.f, agg.r, agg.p, agg.c]) AS m(v)
)`.as("overall_score");

/** 未终结的 run（原型 §6「全局同时最多 1 个 run(串行队列)」的判定集合）。 */
const ACTIVE_STATUSES = ["queued", "running"] as const;

@Injectable()
export class EvalRunsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  /** 原型 §7「run 列表页：时间倒序」。 */
  async listAggregates(): Promise<EvalRunAggregate[]> {
    return await this.selectAggregates(undefined);
  }

  async findAggregateById(id: string): Promise<EvalRunAggregate | undefined> {
    return (await this.selectAggregates(id))[0];
  }

  async findRunById(id: string): Promise<EvalRunRow | undefined> {
    const rows = await this.db.select().from(evalRuns).where(eq(evalRuns.id, id)).limit(1);
    return rows[0];
  }

  /** 全局串行：任一 queued/running 的 run 都挡住新发起（原型 §6）。 */
  async findActiveRun(): Promise<EvalRunRow | undefined> {
    const rows = await this.db
      .select()
      .from(evalRuns)
      .where(inArray(evalRuns.status, [...ACTIVE_STATUSES]))
      .orderBy(asc(evalRuns.createdAt))
      .limit(1);
    return rows[0];
  }

  /**
   * 1h 幂等（原型 §6）：同集 × 同配置版本、`finished_at` 在窗口内的**已完成** run。
   * 只认 `done` —— `partial`/`budget_stop` 是没跑全的结果，拿它当「已有最近结果」复用会骗人。
   */
  async findRecentDoneRun(
    setId: string,
    configVersionId: string,
    since: Date,
  ): Promise<EvalRunRow | undefined> {
    const rows = await this.db
      .select()
      .from(evalRuns)
      .where(
        and(
          eq(evalRuns.setId, setId),
          eq(evalRuns.configVersionId, configVersionId),
          eq(evalRuns.status, "done"),
          gt(evalRuns.finishedAt, since),
        ),
      )
      .orderBy(desc(evalRuns.finishedAt))
      .limit(1);
    return rows[0];
  }

  async insertRun(input: NewEvalRunInput): Promise<EvalRunRow> {
    const rows = await this.db.insert(evalRuns).values(input).returning();
    return rows[0];
  }

  /** 置停止信号；返回 false = 已是终态（并发终结）→ service 抛 409。 */
  async requestStop(id: string, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(evalRuns)
      .set({ stopRequestedAt: now })
      .where(and(eq(evalRuns.id, id), inArray(evalRuns.status, [...ACTIVE_STATUSES])))
      .returning({ id: evalRuns.id });
    return rows.length === 1;
  }

  /**
   * 条件更新抢租约（仿 `evaluations.repository.ts:85-101` 的既有形状）：
   * 无租约 / 租约过期 / 本人续租三种情况可抢，其余（他人持有且未过期）抢不到。
   */
  async tryAcquireLease(id: string, owner: string, now: Date, ttlMs: number): Promise<boolean> {
    const rows = await this.db
      .update(evalRuns)
      .set({ leaseOwner: owner, leaseUntil: new Date(now.getTime() + ttlMs) })
      .where(
        and(
          eq(evalRuns.id, id),
          or(
            isNull(evalRuns.leaseUntil),
            lt(evalRuns.leaseUntil, now),
            eq(evalRuns.leaseOwner, owner),
          ),
        ),
      )
      .returning({ id: evalRuns.id });
    return rows.length === 1;
  }

  /**
   * 续租（心跳）——**必须逐条用例调用**，否则长 run 会把自己的租约跑过期。
   *
   * `EVAL_RUN_LEASE_MS` 是 5 分钟，而一个 50 题的 run 轻易跑 8 分钟以上（原型 §6 自己
   * 估「3~6 分钟」，且单条超时就 30s）。不续租的话，健康的长 run 在中途就会**被自己的
   * 租约判成「已放弃」**——于是 ① 另一个 worker 能抢走同一条 run 并发跑；② 下面的
   * `reapAbandonedRuns` 会把它误杀成 failed。租约必须表达「worker 还活着」，而不是
   * 「run 开始还没超过 5 分钟」。
   *
   * 条件更新 `lease_owner = owner`：租约已被别人抢走时是 no-op（返回 false），
   * 调用方据此知道自己已失去所有权。
   */
  async renewLease(id: string, owner: string, now: Date, ttlMs: number): Promise<boolean> {
    const rows = await this.db
      .update(evalRuns)
      .set({ leaseUntil: new Date(now.getTime() + ttlMs) })
      .where(and(eq(evalRuns.id, id), eq(evalRuns.leaseOwner, owner)))
      .returning({ id: evalRuns.id });
    return rows.length === 1;
  }

  /**
   * 回收被遗弃的 run（worker 进程被杀 / OOM / 机器掉电 —— 这些路径下 `finally` 的
   * `releaseLease` 与 pg-boss 的重试都不会发生）。
   *
   * 为什么必须有：`create` 的全局串行守卫把 `queued|running` 一律视为「有活跃 run」→ 409。
   * 一条卡在 `running` 的僵尸 run 会**永久占住那个唯一槽位**，整个离线评测功能从此再也
   * 发不起任何 run，只能人工 SQL 修。这不是「W2b 再说」的事，是一次崩溃就锁死全功能。
   *
   * 判据是**租约过期**而非「跑得久」——因为有了上面的续租，租约过期严格等价于「worker 没了」。
   * 5 分钟 TTL 远长于 pg-boss 的重试节奏，故正常重试路径会先把 run 重新跑起来（并续上租约），
   * 本回收器只在**重试也救不回来**时兜底 → 不会架空 `retryLimit: 3`。
   *
   * 收成 `failed` 而非退回 `queued`：018 §11 的状态机里「queued/running → failed」就是
   * 「job 异常重试 3 次仍败」这一格；且已完成的用例结果行照常保留，报告按 snapshot 推导 skipped。
   */
  async reapAbandonedRuns(now: Date): Promise<string[]> {
    const rows = await this.db
      .update(evalRuns)
      .set({
        status: "failed",
        finishedAt: now,
        error: "评测执行异常中断（worker 未在租约内续期）",
        leaseOwner: null,
        leaseUntil: null,
      })
      .where(and(eq(evalRuns.status, "running"), lt(evalRuns.leaseUntil, now)))
      .returning({ id: evalRuns.id });
    return rows.map((r) => r.id);
  }

  /** 只释放自己持有的租约（他人已抢走时是 no-op，不会误放）。 */
  async releaseLease(id: string, owner: string): Promise<void> {
    await this.db
      .update(evalRuns)
      .set({ leaseOwner: null, leaseUntil: null })
      .where(and(eq(evalRuns.id, id), eq(evalRuns.leaseOwner, owner)));
  }

  /**
   * `startedAt` 用 COALESCE 只在首次置位：pg-boss 重试会对同一条 run 再走一遍本方法，
   * 直接覆盖会把开始时间推后到重试时刻 → 报告耗时凭空缩水（甚至短于实际已跑的用例耗时和）。
   */
  async markRunning(id: string, now: Date): Promise<void> {
    await this.db
      .update(evalRuns)
      .set({ status: "running", startedAt: sql`COALESCE(${evalRuns.startedAt}, ${now})` })
      .where(eq(evalRuns.id, id));
  }

  async finishRun(id: string, status: string, now: Date, error: string | null): Promise<void> {
    await this.db
      .update(evalRuns)
      .set({ status, finishedAt: now, error })
      .where(eq(evalRuns.id, id));
  }

  /**
   * 单事务：结果行 + run 进度（`done_cases`/`tokens_used`）。
   * 分两步会在中间失败时让进度与结果行对不上——而重试路径按「已落结果行」判断跑到哪，
   * 计数漂了就再也对不齐。累加用 SQL 表达式而非读改写，避免并发丢更新。
   */
  async recordResult(input: NewEvalRunResultInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      const { runId, tokensUsed, ...rest } = input;
      await tx.insert(evalRunResults).values({ runId, tokensUsed, ...rest });
      await tx
        .update(evalRuns)
        .set({
          doneCases: sql`${evalRuns.doneCases} + 1`,
          tokensUsed: sql`${evalRuns.tokensUsed} + ${tokensUsed}`,
        })
        .where(eq(evalRuns.id, runId));
    });
  }

  /** 报告逐用例表：默认排序「最差指标升序」（坏的浮顶——原型 §7）；NULL 排最后。 */
  async listResults(runId: string): Promise<EvalRunResultWithCase[]> {
    return await this.db
      .select({
        id: evalRunResults.id,
        runId: evalRunResults.runId,
        caseVersionId: evalRunResults.caseVersionId,
        seq: evalRunResults.seq,
        verdict: evalRunResults.verdict,
        faithfulness: evalRunResults.faithfulness,
        answerRelevancy: evalRunResults.answerRelevancy,
        contextPrecision: evalRunResults.contextPrecision,
        correctness: evalRunResults.correctness,
        minMetric: evalRunResults.minMetric,
        minScore: evalRunResults.minScore,
        evidence: evalRunResults.evidence,
        previewTraceId: evalRunResults.previewTraceId,
        answer: evalRunResults.answer,
        tokensUsed: evalRunResults.tokensUsed,
        durationMs: evalRunResults.durationMs,
        error: evalRunResults.error,
        createdAt: evalRunResults.createdAt,
        caseId: evalCaseVersions.caseId,
        caseVersion: evalCaseVersions.version,
        question: evalCaseVersions.question,
      })
      .from(evalRunResults)
      .innerJoin(evalCaseVersions, eq(evalCaseVersions.id, evalRunResults.caseVersionId))
      .where(eq(evalRunResults.runId, runId))
      .orderBy(sql`${evalRunResults.minScore} ASC NULLS LAST`, asc(evalRunResults.seq));
  }

  /** 重试续跑用：已落结果行的用例版本 id（唯一索引 `(run_id, case_version_id)` 的对偶）。 */
  async listRecordedCaseVersionIds(runId: string): Promise<string[]> {
    const rows = await this.db
      .select({ caseVersionId: evalRunResults.caseVersionId })
      .from(evalRunResults)
      .where(eq(evalRunResults.runId, runId));
    return rows.map((row) => row.caseVersionId);
  }

  /** 快照条目 → 用例版本内容（版本行不可变、永不删，故按 id 直取即可）。 */
  async findCaseVersionsByIds(ids: string[]): Promise<EvalCaseVersionContent[]> {
    if (ids.length === 0) return [];
    return await this.db
      .select({
        id: evalCaseVersions.id,
        caseId: evalCaseVersions.caseId,
        version: evalCaseVersions.version,
        question: evalCaseVersions.question,
        goldPoints: evalCaseVersions.goldPoints,
      })
      .from(evalCaseVersions)
      .where(inArray(evalCaseVersions.id, ids));
  }

  private async selectAggregates(id: string | undefined): Promise<EvalRunAggregate[]> {
    const query = this.db
      .select({
        id: evalRuns.id,
        setId: evalRuns.setId,
        applicationId: evalRuns.applicationId,
        configVersionId: evalRuns.configVersionId,
        judgeModelId: evalRuns.judgeModelId,
        embeddingModelId: evalRuns.embeddingModelId,
        offlineJudgeVersion: evalRuns.offlineJudgeVersion,
        status: evalRuns.status,
        scope: evalRuns.scope,
        caseVersionSnapshot: evalRuns.caseVersionSnapshot,
        totalCases: evalRuns.totalCases,
        doneCases: evalRuns.doneCases,
        tokenBudget: evalRuns.tokenBudget,
        tokensUsed: evalRuns.tokensUsed,
        stopRequestedAt: evalRuns.stopRequestedAt,
        leaseOwner: evalRuns.leaseOwner,
        leaseUntil: evalRuns.leaseUntil,
        startedAt: evalRuns.startedAt,
        finishedAt: evalRuns.finishedAt,
        error: evalRuns.error,
        createdBy: evalRuns.createdBy,
        createdAt: evalRuns.createdAt,
        // 集软删后报告仍要能看（原型 §19.2「历史报告仍可查看」）→ join 不过滤 deleted_at。
        setName: evalSets.name,
        overallScore: OVERALL_SCORE,
      })
      .from(evalRuns)
      .innerJoin(evalSets, eq(evalSets.id, evalRuns.setId));
    const rows = id
      ? await query.where(eq(evalRuns.id, id))
      : await query.orderBy(desc(evalRuns.createdAt));
    return rows as EvalRunAggregate[];
  }
}
