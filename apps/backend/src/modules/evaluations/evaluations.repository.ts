import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { DRIZZLE } from "../../platform/persistence/drizzle.constants";
import type { DB } from "../../platform/persistence/persistence.module";
import {
  evalCandidateLedger,
  evalManualScoreJobs,
  evalWatermarks,
  onlineEvalSettings,
  type EvalManualScoreJobRow,
  type EvalWatermarkRow,
  type OnlineEvalSettingsRow,
} from "./schema";

/** 游标越过一条 trace 时记下的一笔账。对应 evalCandidateLedger 的一行。 */
export interface LedgerEntry {
  targetTraceId: string;
  traceStartTime: Date;
  agentId: string;
  outcome: string;
  lastError?: string | null;
}

export type OnlineEvalSettingsUpdate = Partial<Omit<OnlineEvalSettingsRow, "id" | "updatedAt">>;

export interface FinishEvaluationCycle {
  lastTs: Date;
  lastTraceId: string;
  evaluatedIncrement: number;
  now: Date;
  /**
   * 裁判健康状态。**`undefined` = 本轮没动过裁判 ⇒ 不改写这两列**（保住上一次真实故障）；
   * 传值 = 本轮确实调过裁判，该值就是权威。
   * 曾经这两列被无条件写成 `?? 0` / `?? null`，而空轮也走 finishCycle ⇒ 任何一个无所事事的
   * 轮次都会把「上次为什么失败」擦干净（018 §12 缺口 20 的排除论证 ③ 正因此失效）。
   */
  consecutiveFailures?: number;
  lastError?: string | null;
  /** 本轮游标是否真的前进了——决定要不要更新 lastCursorMoveAt。 */
  cursorMoved?: boolean;
  /** 本轮游标越过的每一条。与游标推进**同事务**写入，见 finishCycle 的注释。 */
  ledger?: LedgerEntry[];
  /** 账本行归属的 judgeVersion（同一 trace 换版本重评是另一笔账）。有 ledger 时必给。 */
  judgeVersion?: string;
}

function utcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

@Injectable()
export class EvaluationsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  async getSettings(): Promise<OnlineEvalSettingsRow> {
    await this.db.insert(onlineEvalSettings).values({ id: "default" }).onConflictDoNothing();
    const [settings] = await this.db
      .select()
      .from(onlineEvalSettings)
      .where(eq(onlineEvalSettings.id, "default"))
      .limit(1);
    if (!settings) throw new Error("online evaluation settings unavailable");
    return settings;
  }

  async updateSettings(
    update: OnlineEvalSettingsUpdate,
    now = new Date(),
  ): Promise<OnlineEvalSettingsRow> {
    await this.getSettings();
    const [settings] = await this.db
      .update(onlineEvalSettings)
      .set({ ...update, updatedAt: now })
      .where(eq(onlineEvalSettings.id, "default"))
      .returning();
    if (!settings) throw new Error("online evaluation settings unavailable");
    return settings;
  }

  /**
   * 只读取水位线，不存在也不创建——读路径（屏1 总览）专用。
   * getOrCreateWatermark 会把游标播种在 now-24h，那是**破坏性**的：此后所有更早的 trace
   * 永久出不了候选集。它只该由真正要推进游标的 worker 调用；一个 GET 绝不能有这种副作用
   * （曾经有：打开屏1 即钉死游标，尤其在只起 api 没起 worker 时）。
   */
  async findWatermark(workerName: string): Promise<EvalWatermarkRow | undefined> {
    const [watermark] = await this.db
      .select()
      .from(evalWatermarks)
      .where(eq(evalWatermarks.workerName, workerName))
      .limit(1);
    return watermark;
  }

  /**
   * `seedFrom` 只在**行不存在**时决定游标起点——`onConflictDoNothing` 保护重启（保住原游标），
   * 但保护不了诞生：那一刻起，早于 seedFrom 的 trace 永不进候选集（`listCandidates` 只往前看）。
   * 默认 `now - 24h` = `017:26` 的原行为；调用方（worker）按 `ONLINE_EVAL_BACKFILL_WINDOW_HOURS`
   * 覆盖。默认值留在这里是为了让「不传 = 原行为」，既有调用点与测试无需改动。
   */
  async getOrCreateWatermark(
    workerName: string,
    now: Date,
    seedFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000),
  ): Promise<EvalWatermarkRow> {
    const today = utcDate(now);
    await this.db
      .insert(evalWatermarks)
      .values({
        workerName,
        lastTs: seedFrom,
        lastTraceId: "",
        dailyDate: today,
      })
      .onConflictDoNothing();
    await this.db
      .update(evalWatermarks)
      .set({ dailyDate: today, dailyCount: 0, updatedAt: now })
      .where(
        and(
          eq(evalWatermarks.workerName, workerName),
          sql`${evalWatermarks.dailyDate} <> ${today}`,
        ),
      );
    const [watermark] = await this.db
      .select()
      .from(evalWatermarks)
      .where(eq(evalWatermarks.workerName, workerName))
      .limit(1);
    if (!watermark) throw new Error(`evaluation watermark unavailable: ${workerName}`);
    return watermark;
  }

  /**
   * 水位线的行就是在这里诞生的——**worker 真正开工的那一刻**，也是唯一该播种的时机。
   * 故 `seedFrom` 必须一路透传到这里；只传给 `getOrCreateWatermark` 是够不着的。
   */
  async tryAcquireLease(
    workerName: string,
    owner: string,
    now: Date,
    ttlMs: number,
    seedFrom?: Date,
  ): Promise<boolean> {
    await this.getOrCreateWatermark(workerName, now, seedFrom);
    const rows = await this.db
      .update(evalWatermarks)
      .set({
        leaseOwner: owner,
        leaseUntil: new Date(now.getTime() + ttlMs),
        lastRunAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(evalWatermarks.workerName, workerName),
          or(
            isNull(evalWatermarks.leaseUntil),
            lt(evalWatermarks.leaseUntil, now),
            eq(evalWatermarks.leaseOwner, owner),
          ),
        ),
      )
      .returning({ workerName: evalWatermarks.workerName });
    return rows.length === 1;
  }

  /**
   * 游标推进与账本记账**必须原子**：崩在两者之间会造出「游标过了但没记账」——那正是本设计
   * 要消灭的黑洞，而半修只会造成「已加固」的错觉。故整段包事务。
   *
   * 账本记的是「worker 对这条 trace 做了什么」，**不是「游标越过了哪些」**——两者不等价：
   * `cap_deferred`/`circuit_deferred` 之后的候选照样被处理（循环用 `continue` 不是 `break`，
   * 只有游标的推进循环才 break），它们有终态 outcome 但游标这轮够不着。那些行照记，
   * 下一轮重新扫到时 `seenCount` 累加。
   */
  async finishCycle(
    workerName: string,
    owner: string,
    result: FinishEvaluationCycle,
  ): Promise<void> {
    const today = utcDate(result.now);
    await this.db.transaction(async (tx) => {
      if (result.ledger?.length) {
        if (!result.judgeVersion) throw new Error("ledger entries require a judgeVersion");
        await tx
          .insert(evalCandidateLedger)
          .values(
            result.ledger.map((entry) => ({
              targetTraceId: entry.targetTraceId,
              judgeVersion: result.judgeVersion!,
              workerName,
              outcome: entry.outcome,
              traceStartTime: entry.traceStartTime,
              agentId: entry.agentId,
              seenCount: 1,
              firstSeenAt: result.now,
              lastSeenAt: result.now,
              lastError: entry.lastError ?? null,
            })),
          )
          .onConflictDoUpdate({
            target: [evalCandidateLedger.targetTraceId, evalCandidateLedger.judgeVersion],
            set: {
              // 同一条被重复扫到（cap/circuit 前缀之后的候选会这样）：累加而非覆盖计数，
              // 但 outcome/lastError 取最新——最后一次的判定才是当前事实。
              seenCount: sql`${evalCandidateLedger.seenCount} + 1`,
              outcome: sql`excluded.outcome`,
              lastSeenAt: sql`excluded.last_seen_at`,
              lastError: sql`excluded.last_error`,
              workerName: sql`excluded.worker_name`,
            },
          });
      }
      await tx
        .update(evalWatermarks)
        .set({
          lastTs: result.lastTs,
          lastTraceId: result.lastTraceId,
          dailyDate: today,
          dailyCount: sql`CASE
          WHEN ${evalWatermarks.dailyDate} = ${today}
            THEN ${evalWatermarks.dailyCount} + ${result.evaluatedIncrement}
          ELSE ${result.evaluatedIncrement}
        END`,
          leaseOwner: null,
          leaseUntil: null,
          lastRunAt: result.now,
          lastSuccessAt: result.now,
          // 「跑过」与「走过」是两件事：空转一轮也更新 lastRunAt，但游标可能几天没动。
          ...(result.cursorMoved ? { lastCursorMoveAt: result.now } : {}),
          // 没动过裁判就不碰这两列——见 FinishEvaluationCycle 的注释。
          ...(result.consecutiveFailures === undefined
            ? {}
            : { consecutiveFailures: result.consecutiveFailures }),
          ...(result.lastError === undefined ? {} : { lastError: result.lastError }),
          updatedAt: result.now,
        })
        .where(
          and(eq(evalWatermarks.workerName, workerName), eq(evalWatermarks.leaseOwner, owner)),
        );
    });
  }

  async releaseLease(workerName: string, owner: string, now = new Date()): Promise<void> {
    await this.db
      .update(evalWatermarks)
      .set({ leaseOwner: null, leaseUntil: null, updatedAt: now })
      .where(and(eq(evalWatermarks.workerName, workerName), eq(evalWatermarks.leaseOwner, owner)));
  }

  /**
   * 窗口内账本按 outcome 的计数（按 **trace 发生时间**切窗，与屏1 的 eligible/evaluable 同基准，
   * 故三者可做算术）。
   *
   * ⚠️ 账本只覆盖「worker **看过**的」。游标播种时被孤儿化的 trace **从没进过候选集**、
   * 没有账本行——它们正是「已错过」减去本表之后剩下的那部分（屏1 的「从没被看过」）。
   * 不要拿本表当「已错过」的全部，那会把最大的一类漏掉。
   */
  async countLedgerByOutcome(
    judgeVersion: string,
    from: Date,
    to: Date,
    agentId?: string,
  ): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ outcome: evalCandidateLedger.outcome, count: sql<string>`count(*)` })
      .from(evalCandidateLedger)
      .where(
        and(
          eq(evalCandidateLedger.judgeVersion, judgeVersion),
          gte(evalCandidateLedger.traceStartTime, from),
          lt(evalCandidateLedger.traceStartTime, to),
          ...(agentId ? [eq(evalCandidateLedger.agentId, agentId)] : []),
        ),
      )
      .groupBy(evalCandidateLedger.outcome);
    return Object.fromEntries(rows.map((row) => [row.outcome, Number(row.count)]));
  }

  /** 按 trace 发生时间清理旧账本行。返回删除行数。 */
  async pruneLedger(before: Date): Promise<number> {
    const rows = await this.db
      .delete(evalCandidateLedger)
      .where(lt(evalCandidateLedger.traceStartTime, before))
      .returning({ targetTraceId: evalCandidateLedger.targetTraceId });
    return rows.length;
  }

  /**
   * 行不存在时**不创建**——一个失败的轮次不该顺手把游标播种下去。原先它调 getOrCreateWatermark，
   * 于是「模型还没配好就跑了一轮」会以 `now-24h` 建行，把更早的历史永久排除出候选集，
   * 而这个播种时刻与任何人的意图都无关。行不存在 = worker 没真正开工过，
   * 屏1 已由 `worker_stalled`（无行/lastRunAt 陈旧）与 `model_unavailable`（独立查模型）如实表达，
   * 不需要靠这行记账。
   */
  async recordFailure(workerName: string, errorClass: string, message: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(evalWatermarks)
      .set({
        lastRunAt: now,
        consecutiveFailures: sql`${evalWatermarks.consecutiveFailures} + 1`,
        lastError: `${errorClass}: ${message}`.slice(0, 200),
        updatedAt: now,
      })
      .where(eq(evalWatermarks.workerName, workerName));
  }

  // —— B1/F3：人工「立即评测」作业表 ——
  //
  // ⚠️ 这三个方法**只碰 eval_manual_score_jobs**。绝不写 eval_candidate_ledger，
  // 也绝不写 eval_watermarks 任一列（含 daily_count）——人工触发不推进游标，
  // 记进账本会把「人工点了一下」伪装成一次 worker 扫描，屏1 的 missed/scoresNotPersisted
  // 当场失真；吃 dailyCap 则会让一次排查把当天的自动抽样饿死。

  /** 入队前置位。已存在（含 failed）则重置为 queued —— 这就是「重试」。 */
  async upsertManualJob(
    targetTraceId: string,
    judgeVersion: string,
    requestedBy: string,
  ): Promise<void> {
    const now = new Date();
    await this.db
      .insert(evalManualScoreJobs)
      .values({ targetTraceId, judgeVersion, status: "queued", attempts: 0, requestedBy })
      .onConflictDoUpdate({
        target: [evalManualScoreJobs.targetTraceId, evalManualScoreJobs.judgeVersion],
        set: { status: "queued", attempts: 0, lastError: null, requestedBy, updatedAt: now },
      });
  }

  async findManualJob(
    targetTraceId: string,
    judgeVersion: string,
  ): Promise<EvalManualScoreJobRow | undefined> {
    const rows = await this.db
      .select()
      .from(evalManualScoreJobs)
      .where(
        and(
          eq(evalManualScoreJobs.targetTraceId, targetTraceId),
          eq(evalManualScoreJobs.judgeVersion, judgeVersion),
        ),
      )
      .limit(1);
    return rows[0];
  }

  async markManualJob(
    targetTraceId: string,
    judgeVersion: string,
    patch: { status: "running" | "scored" | "failed"; lastError?: string | null; bumpAttempt?: boolean },
  ): Promise<void> {
    await this.db
      .update(evalManualScoreJobs)
      .set({
        status: patch.status,
        lastError: patch.lastError ?? null,
        updatedAt: new Date(),
        ...(patch.bumpAttempt ? { attempts: sql`${evalManualScoreJobs.attempts} + 1` } : {}),
      })
      .where(
        and(
          eq(evalManualScoreJobs.targetTraceId, targetTraceId),
          eq(evalManualScoreJobs.judgeVersion, judgeVersion),
        ),
      );
  }

}
