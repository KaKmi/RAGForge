import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { DRIZZLE } from "../../platform/persistence/drizzle.constants";
import type { DB } from "../../platform/persistence/persistence.module";
import {
  evalWatermarks,
  onlineEvalSettings,
  type EvalWatermarkRow,
  type OnlineEvalSettingsRow,
} from "./schema";

export type OnlineEvalSettingsUpdate = Partial<Omit<OnlineEvalSettingsRow, "id" | "updatedAt">>;

export interface FinishEvaluationCycle {
  lastTs: Date;
  lastTraceId: string;
  evaluatedIncrement: number;
  now: Date;
  consecutiveFailures?: number;
  lastError?: string | null;
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

  async getOrCreateWatermark(workerName: string, now: Date): Promise<EvalWatermarkRow> {
    const today = utcDate(now);
    await this.db
      .insert(evalWatermarks)
      .values({
        workerName,
        lastTs: new Date(now.getTime() - 24 * 60 * 60 * 1000),
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

  async tryAcquireLease(
    workerName: string,
    owner: string,
    now: Date,
    ttlMs: number,
  ): Promise<boolean> {
    await this.getOrCreateWatermark(workerName, now);
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

  async finishCycle(
    workerName: string,
    owner: string,
    result: FinishEvaluationCycle,
  ): Promise<void> {
    const today = utcDate(result.now);
    await this.db
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
        consecutiveFailures: result.consecutiveFailures ?? 0,
        lastError: result.lastError ?? null,
        updatedAt: result.now,
      })
      .where(and(eq(evalWatermarks.workerName, workerName), eq(evalWatermarks.leaseOwner, owner)));
  }

  async releaseLease(workerName: string, owner: string, now = new Date()): Promise<void> {
    await this.db
      .update(evalWatermarks)
      .set({ leaseOwner: null, leaseUntil: null, updatedAt: now })
      .where(and(eq(evalWatermarks.workerName, workerName), eq(evalWatermarks.leaseOwner, owner)));
  }

  async recordFailure(workerName: string, errorClass: string, message: string): Promise<void> {
    const now = new Date();
    await this.getOrCreateWatermark(workerName, now);
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
}
