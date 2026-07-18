import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { DRIZZLE } from "../../platform/persistence/drizzle.constants";
import { EVAL_RUN_REAP_GRACE_MS } from "./eval-run.constants";
import type { DB } from "../../platform/persistence/persistence.module";
import {
  evalCaseVersions,
  evalRunResults,
  evalRuns,
  evalSets,
  type EvalRunResultRow,
  type EvalRunRow,
  type EvalRunSnapshotEntry,
  type GoldDocRefRow,
} from "./schema";

export interface NewEvalRunInput {
  setId: string;
  applicationId: string;
  configVersionId: string;
  judgeModelId: string;
  embeddingModelId: string;
  caseVersionSnapshot: EvalRunSnapshotEntry[];
  totalCases: number;
  /** §14/F5：每题重复次数（默认 1）。 */
  repeatCount: number;
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
  /** F2 检索层 gold 指标消费。 */
  goldDocRefs: GoldDocRefRow[];
}

export interface NewEvalRunResultInput {
  runId: string;
  caseVersionId: string;
  seq: number;
  /** F5：本行第几次重复（1-5）。 */
  repeatIndex: number;
  verdict: string;
  faithfulness: number | null;
  answerRelevancy: number | null;
  contextPrecision: number | null;
  correctness: number | null;
  /** F4：Citation。 */
  citation: number | null;
  /** F2：检索层 gold 指标。 */
  contextRecall: number | null;
  ndcg5: number | null;
  hitRate5: number | null;
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

/**
 * 「活跃槽位」唯一索引冲突（018 §12 缺口 13）。形状照
 * `ingestion/processing-runs.repository.ts:11-15` 的 `isActiveRunConflict`。
 *
 * ⚠️ 两处细节都不能省：
 *  · **必须拆 `cause`** —— drizzle 0.45 的 pg-core session 把 pg 错误包进
 *    `DrizzleQueryError.cause`，直接读 `error.code` 恒 undefined。
 *  · **必须按约束名精确匹配** —— `eval_run_results_run_case_unique` 也是 23505，
 *    笼统吞掉会把「续跑撞唯一索引」这类真 bug 伪装成正常的 409。
 */
export function isSingleActiveRunConflict(error: unknown): boolean {
  const candidate = (error as { cause?: unknown } | null)?.cause ?? error;
  const pgError = candidate as { code?: string; constraint?: string } | null;
  return pgError?.code === "23505" && pgError.constraint === "eval_runs_single_active_unique";
}

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

  /**
   * F6：存在 queued/running 的 run 引用该应用 → 拦其删除（保护正在跑/排队的评测）。
   * 终态 run 引用不拦（历史报告优雅降级，见 eval-runs.service UNRESOLVED_VERSION_LABEL）。
   */
  async existsActiveRunByApplicationId(applicationId: string): Promise<boolean> {
    const rows = await this.db
      .select({ one: sql`1` })
      .from(evalRuns)
      .where(
        and(
          eq(evalRuns.applicationId, applicationId),
          inArray(evalRuns.status, [...ACTIVE_STATUSES]),
        ),
      )
      .limit(1);
    return rows.length > 0;
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
   *
   * 两条遗弃路径都要覆盖（peer review 实测：只覆盖前者是不够的）：
   *  · **进程被杀**：`finally` 不执行 → 租约留在原处、自然过期。
   *  · **未捕获异常**：`finally` **会**执行 `releaseLease` → 故 release 必须留下一个
   *    **已过期的时间戳**而非 NULL（见 `releaseLease` 注释）；否则 `NULL < ts` 求值为
   *    NULL 而非 TRUE，这条 run 永不被回收 —— 而这恰恰是更常见的一条路径。
   *
   * 不架空 `retryLimit: 3` 靠的是 `EVAL_RUN_REAP_GRACE_MS`（15min > pg-boss 的
   * `expire_seconds` 15min 默认值量级）**而不是**租约 TTL：异常路径上 pg-boss 的
   * `retry_delay` 默认是 **0**（立刻重试），比 5 分钟 TTL 快得多，所以「TTL 长于重试节奏」
   * 这个理由是**反的**。真正保证重试先跑的是宽限期。
   *
   * 收成 `failed` 而非退回 `queued`：018 §11 的状态机里「queued/running → failed」就是
   * 「job 异常重试 3 次仍败」这一格；且已完成的用例结果行照常保留，报告按 snapshot 推导 skipped。
   *
   * ## 为什么 `queued` 也必须回收（两态判据不同源）
   *
   * `running` 的存活证据是**租约**（worker 逐条续租）；`queued` 的存活证据是**队列里有个 job**——
   * 而后者是 PG 看不见的外部状态，租约在 markRunning 之前根本还没建立。于是只认 `running`
   * 会漏掉「job 已消失的 queued 孤儿」，而 `findActiveRun` 的 `ACTIVE_STATUSES` 把 queued
   * 一视同仁当活跃 → 守卫覆盖面**宽于**回收器，这个差集就是死锁：此后每次 `POST /eval/runs`
   * 恒 409，`stop()` 又只置信号不改状态 → **整个离线评测功能永久死亡，只能人工改库**。
   * 这与上面 `running` 僵尸是同一类缺陷，只是当初漏了这一半。
   *
   * 两条可达路径（终态不同，故判据必须落在 `created_at` 而非租约上）：
   *  · **insertRun 成功、publish 前进程被杀**：`lease_until` 恒 NULL（没有 worker 碰过它），
   *    且**没有任何 job 存在** → 再也不会有人来跑。service 的 try/catch 只兜住 publish
   *    **抛出**，兜不住进程**消失**。
   *  · **markRunning 前瞬时 DB 错误、重试耗尽**：`finally` 的 releaseLease 留下
   *    `lease_until=<过去>` 而 status 仍是 `queued`（从未 markRunning）→ pg-boss 弃投后同样成孤儿。
   *
   * 判据用 `created_at < now - GRACE` **且无人持租**：健康的 queued 只存在**数秒**（pg-boss
   * 取走 job 后立刻 markRunning），故「创建超过 15 分钟仍是 queued」= job 大概率没了。
   * GRACE 的余量论证同 `running`：retry_delay 默认 0 → 4 次重试在数秒内跑完，15 分钟宽限期
   * 不架空 retryLimit: 3。
   *
   * ### 为什么 `created_at` 一个条件**不够**——必须叠加租约活性
   *
   * `created_at` **判不出**「job 还在排队」与「job 没了」的区别：backend 宕机/部署超过 GRACE 时，
   * job 在 pg-boss 里**持久化于 PG**，进程回来后照常被取走 —— 这条 run 的 `created_at` 早得很，
   * 但它完全健康。而 worker 的 `tryAcquireLease` 与 `markRunning` 之间隔着两次 DB 往返，
   * 任一 `POST /eval/runs` 都会在 `findActiveRun` 守卫**之前**触发本回收器（service:172，
   * 连注定 409 的请求也触发）→ 只看 `created_at` 就会把一条**活 worker 正持有**的 run 判死。
   *
   * 故 queued 臂必须同时要求「无活租约」（`lease_until IS NULL OR lease_until < now`），
   * 恢复 `running` 臂本来就有的那层保护：**持租即免疫回收**。`tryAcquireLease` 是原子的，
   * 它一旦成功，这条 run 就有了「有人正在管它」的证据，回收器必须让路。反过来，两条**真孤儿**
   * 路径的租约证据都不成立（NULL / 过期时间戳），照常被回收 —— 覆盖面没有缩小。
   *
   * READ COMMITTED 下也够：本 UPDATE 取行锁后会重算谓词 → `tryAcquireLease` 先提交则跳过该行；
   * 本回收器先提交则 worker 的 `findRunById` 读到 `failed` → `already_finished` 干净退出。
   * 配套 `markRunning` 的租约守卫兜住第三种交错（回收落在 acquire 与 markRunning 之间）。
   *
   * 残余窗口（018 §11 已记）：job 在队列里干等超过一个 GRACE **且无人持租**时（worker 在
   * `tryAcquireLease` 前挂起、或 job 迟迟未被取走），回收会先于最后一次重试 → 该 run 判 failed
   * 而非续跑。代价是「卡了 15 分钟的 run 诚实地失败」，换来的是死锁**必然自愈**，划算。
   */
  async reapAbandonedRuns(now: Date): Promise<string[]> {
    // 宽限期：`lease_until < now - GRACE`，不是 `< now`。GRACE > pg-boss 的 job 过期时间，
    // 保证「未捕获异常 → releaseLease → 立刻重试」这条路径上，**重试永远先于回收**，
    // 不架空 retryLimit: 3（详见 EVAL_RUN_REAP_GRACE_MS 的注释）。
    const deadline = new Date(now.getTime() - EVAL_RUN_REAP_GRACE_MS);
    const rows = await this.db
      .update(evalRuns)
      .set({
        status: "failed",
        finishedAt: now,
        // 两类孤儿的死因不同，横幅要说实话：queued 是「压根没启动」，running 是「跑到一半没了」。
        // PG 的 UPDATE ... SET 里所有表达式都读**更新前**的行值，故此处 CASE 看到的是原 status。
        //
        // queued 文案只陈述**观察得到的事实**（超过宽限期无人接管），不断言「任务已丢失」——
        // 回收器根本判不出 job 是丢了还是还在队列里干等（后者在 backend 宕机 > GRACE 后重启时
        // 真实可达，job 持久化在 PG 里、随后照常被取走）。说「已丢失」在那种情形下与事实相反，
        // 恰好背反本 CASE「横幅要说实话」的初衷。故只说事实 + 给出动作。
        error: sql`CASE WHEN ${evalRuns.status} = 'queued'
          THEN '评测未能启动（超过宽限期仍无 worker 接管，可重新发起）'
          ELSE '评测执行异常中断（worker 未在租约内续期）' END`,
        // `leaseOwner: null` 是**必须的**，不是清理洁癖：worker 靠 `renewLease` 的
        // 条件更新（`WHERE lease_owner = owner`）判断自己是否已被回收。若回收时留着
        // 原 owner，被误回收的 worker 续租仍返回 true → 永远不让位 → 继续把结果写进
        // 一条已 `failed` 的 run，`finishRun` 还会把它翻回 `done`（而此时 create 已放行
        // 第二个 run）。清掉 owner，续租立刻返回 false，worker 下一轮迭代即让位。
        leaseOwner: null,
        leaseUntil: null,
      })
      .where(
        or(
          // 僵尸：租约过期（有了逐条续租，过期严格等价于「worker 没了」）。
          and(eq(evalRuns.status, "running"), lt(evalRuns.leaseUntil, deadline)),
          // 孤儿：排队太久**且无人持租**。两个条件缺一不可——见上方「持租即免疫」。
          and(
            eq(evalRuns.status, "queued"),
            lt(evalRuns.createdAt, deadline),
            or(isNull(evalRuns.leaseUntil), lt(evalRuns.leaseUntil, now)),
          ),
        ),
      )
      .returning({ id: evalRuns.id });
    return rows.map((r) => r.id);
  }

  /**
   * 只释放自己持有的租约（他人已抢走时是 no-op，不会误放）。
   *
   * ⚠️ `leaseUntil` 置为 **now（一个已过期的时刻）而不是 NULL** —— 这是回收器能工作的前提。
   * 原先置 NULL 时：`processRun` 的 `finally` 在**未捕获异常**路径上也会跑到这里 →
   * 留下 `{status:'running', lease_until: NULL}`；而回收谓词 `lease_until < now()` 在
   * NULL 上求值为 **NULL 而非 TRUE**（三值逻辑），该行永不匹配 → run 永久卡 `running` →
   * `create` 的全局串行守卫此后永远 409 → **整个离线评测功能死锁，只能人工改库**。
   * 即：release 把回收器赖以判断的证据本身抹掉了。留一个已过期的时间戳，既让重试能立刻
   * 重新抢到租约（`lease_until < now` 可获取），又让回收器在宽限期后仍看得见这条僵尸。
   */
  async releaseLease(id: string, owner: string, now = new Date()): Promise<void> {
    await this.db
      .update(evalRuns)
      .set({ leaseOwner: null, leaseUntil: now })
      .where(and(eq(evalRuns.id, id), eq(evalRuns.leaseOwner, owner)));
  }

  /**
   * `startedAt` 用 COALESCE 只在首次置位：pg-boss 重试会对同一条 run 再走一遍本方法，
   * 直接覆盖会把开始时间推后到重试时刻 → 报告耗时凭空缩水（甚至短于实际已跑的用例耗时和）。
   *
   * ⚠️ **条件更新（`lease_owner = owner` 且租约未过期），返回 false = 我已不是所有者**。
   * 无条件写会把「失去租约」这件事悄悄抹平：`tryAcquireLease` 与 `markRunning` 之间隔着
   * `findRunById` + `resolveForTest`（两次 DB 往返），这个窗口里回收器可能已把该 run 判死
   * （回收会清空 `lease_owner`）。此时无条件的 `WHERE id=$1` 会把一条 `failed` run 写回
   * `running`，且租约恒 NULL —— 两条回收臂**都够不着**它（running 臂要 `lease_until < deadline`，
   * 而 `NULL < ts` 求值为 NULL 而非 TRUE；queued 臂要 `status='queued'`）→ `findActiveRun`
   * 恒返回它 → `POST /eval/runs` 恒 409 → **回收器立意消灭的死锁原样重生，且更不可达**。
   *
   * 与 `renewLease` 同形（`WHERE lease_owner = owner`）：worker 的每一次状态推进都必须先
   * 证明自己仍持有租约。调用方据返回值让位。**不变式：失去租约的 worker 永远写不回 running。**
   */
  async markRunning(id: string, owner: string, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(evalRuns)
      .set({ status: "running", startedAt: sql`COALESCE(${evalRuns.startedAt}, ${now})` })
      .where(
        and(eq(evalRuns.id, id), eq(evalRuns.leaseOwner, owner), gt(evalRuns.leaseUntil, now)),
      )
      .returning({ id: evalRuns.id });
    return rows.length === 1;
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
        repeatIndex: evalRunResults.repeatIndex,
        verdict: evalRunResults.verdict,
        faithfulness: evalRunResults.faithfulness,
        answerRelevancy: evalRunResults.answerRelevancy,
        contextPrecision: evalRunResults.contextPrecision,
        correctness: evalRunResults.correctness,
        citation: evalRunResults.citation,
        contextRecall: evalRunResults.contextRecall,
        ndcg5: evalRunResults.ndcg5,
        hitRate5: evalRunResults.hitRate5,
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
      // F5：先按 seq，再按 repeat_index——聚合按 caseVersionId 分组，明细按重复序稳定。
      .orderBy(asc(evalRunResults.seq), asc(evalRunResults.repeatIndex));
  }

  /**
   * 重试续跑用：已落结果行的 `(caseVersionId, repeatIndex)` 二元组（F5：唯一索引现含 repeat_index）。
   * worker 据此跳过已录 unit，避免撞唯一索引。
   */
  async listRecordedCaseVersionIds(
    runId: string,
  ): Promise<Array<{ caseVersionId: string; repeatIndex: number }>> {
    const rows = await this.db
      .select({
        caseVersionId: evalRunResults.caseVersionId,
        repeatIndex: evalRunResults.repeatIndex,
      })
      .from(evalRunResults)
      .where(eq(evalRunResults.runId, runId));
    return rows;
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
        goldDocRefs: evalCaseVersions.goldDocRefs,
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
        repeatCount: evalRuns.repeatCount,
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
