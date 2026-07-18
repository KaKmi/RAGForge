import { readFileSync } from "fs";
import { join } from "path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { EvaluationsRepository } from "../src/modules/evaluations/evaluations.repository";
import { dbGate } from "./helpers/gated-suite";

const describeDb = dbGate();
const migrationsDir = join(__dirname, "..", "drizzle");
const now = new Date("2026-07-15T02:00:00.000Z");

describeDb("EvaluationsRepository", () => {
  let pool: Pool;
  let repo: EvaluationsRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.MIGRATION_TEST_DATABASE_URL });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    const journal = JSON.parse(
      readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string }> };
    for (const { tag } of journal.entries) {
      const migration = readFileSync(join(migrationsDir, `${tag}.sql`), "utf8");
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await pool.query(statement);
      }
    }
    repo = new EvaluationsRepository(drizzle(pool) as never);
  });

  afterAll(async () => pool?.end());

  it("stores defaults and updates settings", async () => {
    expect((await repo.getSettings()).enabled).toBe(false);
    expect((await repo.updateSettings({ sampleRate: 0.25 }, now)).sampleRate).toBe(0.25);
  });

  it("stores a composite cursor and enforces a renewable lease", async () => {
    const first = await repo.getOrCreateWatermark("online-quality-v1", now);
    expect(first.lastTraceId).toBe("");
    expect(await repo.tryAcquireLease("online-quality-v1", "worker-a", now, 20 * 60_000)).toBe(
      true,
    );
    expect(await repo.tryAcquireLease("online-quality-v1", "worker-b", now, 20 * 60_000)).toBe(
      false,
    );
    await repo.finishCycle("online-quality-v1", "worker-a", {
      lastTs: new Date("2026-07-15T01:00:00.000Z"),
      lastTraceId: "f".repeat(32),
      evaluatedIncrement: 4,
      now,
    });
    const saved = await repo.getOrCreateWatermark("online-quality-v1", now);
    expect(saved.lastTraceId).toBe("f".repeat(32));
    expect(saved.dailyCount).toBe(4);
    expect(saved.leaseOwner).toBeNull();
  });

  it("starts the daily count from the current cycle when a lease crosses UTC midnight", async () => {
    const seedAt = new Date("2026-07-15T23:40:00.000Z");
    const beforeMidnight = new Date("2026-07-15T23:55:00.000Z");
    const afterMidnight = new Date("2026-07-16T00:05:00.000Z");
    const workerName = "midnight-worker";
    await repo.getOrCreateWatermark(workerName, seedAt);
    await repo.tryAcquireLease(workerName, "seed-owner", seedAt, 10 * 60_000);
    await repo.finishCycle(workerName, "seed-owner", {
      lastTs: seedAt,
      lastTraceId: "d".repeat(32),
      evaluatedIncrement: 480,
      now: seedAt,
    });
    expect((await repo.getOrCreateWatermark(workerName, seedAt)).dailyCount).toBe(480);
    expect(await repo.tryAcquireLease(workerName, "worker-a", beforeMidnight, 20 * 60_000)).toBe(
      true,
    );
    await repo.finishCycle(workerName, "worker-a", {
      lastTs: afterMidnight,
      lastTraceId: "e".repeat(32),
      evaluatedIncrement: 3,
      now: afterMidnight,
    });
    const saved = await repo.getOrCreateWatermark(workerName, afterMidnight);
    expect(saved.dailyDate).toBe("2026-07-16");
    expect(saved.dailyCount).toBe(3);
  });

  it("lets a new owner take an expired lease and rejects stale-owner finish and release", async () => {
    const workerName = "takeover-worker";
    const startedAt = new Date("2026-07-15T03:00:00.000Z");
    await repo.getOrCreateWatermark(workerName, startedAt);
    expect(await repo.tryAcquireLease(workerName, "old-owner", startedAt, 1_000)).toBe(true);
    expect(
      await repo.tryAcquireLease(
        workerName,
        "new-owner",
        new Date("2026-07-15T03:00:01.000Z"),
        1_000,
      ),
    ).toBe(false);
    const takeoverAt = new Date("2026-07-15T03:00:01.001Z");
    expect(await repo.tryAcquireLease(workerName, "new-owner", takeoverAt, 20 * 60_000)).toBe(true);

    await repo.finishCycle(workerName, "old-owner", {
      lastTs: new Date("2026-07-15T02:30:00.000Z"),
      lastTraceId: "a".repeat(32),
      evaluatedIncrement: 99,
      now: takeoverAt,
    });
    await repo.releaseLease(workerName, "old-owner", takeoverAt);
    const stillOwned = await repo.getOrCreateWatermark(workerName, takeoverAt);
    expect(stillOwned.leaseOwner).toBe("new-owner");
    expect(stillOwned.lastTraceId).toBe("");
    expect(stillOwned.dailyCount).toBe(0);
  });

  it("records bounded failure state and releases only the current owner", async () => {
    const workerName = "failure-worker";
    const startedAt = new Date("2026-07-15T04:00:00.000Z");
    await repo.getOrCreateWatermark(workerName, startedAt);
    await repo.tryAcquireLease(workerName, "worker-a", startedAt, 20 * 60_000);
    await repo.recordFailure(workerName, "ClickHouseError", "down");
    let saved = await repo.getOrCreateWatermark(workerName, startedAt);
    expect(saved.consecutiveFailures).toBe(1);
    expect(saved.lastError).toBe("ClickHouseError: down");
    expect(saved.leaseOwner).toBe("worker-a");
    await repo.releaseLease(workerName, "worker-a", startedAt);
    saved = await repo.getOrCreateWatermark(workerName, startedAt);
    expect(saved.leaseOwner).toBeNull();
    expect(saved.leaseUntil).toBeNull();
  });

  // 一个失败的轮次不该顺手把游标播种下去：原先 recordFailure 会以 now-24h 建行，
  // 于是「模型还没配好就跑了一轮」永久吃掉更早的历史，而那个播种时刻与任何人的意图无关。
  it("never creates the watermark from a failure record", async () => {
    const workerName = "never-started-worker";
    await repo.recordFailure(workerName, "ModelUnavailable", "judge missing");
    expect(await repo.findWatermark(workerName)).toBeUndefined();
  });

  // 账本与游标推进**必须原子**：崩在两者之间会造出「游标过了但没记账」——那正是账本要
  // 消灭的黑洞。事务语义 fake 复刻不出（同 018 缺口 14 的理由），只能真库测。
  it("prunes ledger rows by trace time and leaves the rest", async () => {
    const workerName = "prune-worker";
    const now = new Date("2026-07-15T08:00:00.000Z");
    await repo.getOrCreateWatermark(workerName, now);
    await repo.tryAcquireLease(workerName, "owner-1", now, 20 * 60_000);
    await repo.finishCycle(workerName, "owner-1", {
      lastTs: now,
      lastTraceId: "d".repeat(32),
      evaluatedIncrement: 0,
      now,
      judgeVersion: "prune-v1",
      ledger: [
        {
          targetTraceId: "d".repeat(32),
          traceStartTime: new Date("2026-05-01T00:00:00.000Z"),
          agentId: "",
          outcome: "sampled_out",
        },
        {
          targetTraceId: "e".repeat(32),
          traceStartTime: new Date("2026-07-14T00:00:00.000Z"),
          agentId: "",
          outcome: "sampled_out",
        },
      ],
    });
    expect(await repo.pruneLedger(new Date("2026-06-15T00:00:00.000Z"))).toBe(1);
    const counts = await repo.countLedgerByOutcome(
      "prune-v1",
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-08-01T00:00:00.000Z"),
    );
    expect(counts).toEqual({ sampled_out: 1 });
  });

  // 播种点是**一次性**的：onConflictDoNothing 保护重启（保住原游标），保护不了诞生。
  // 行建好后再改窗口不得有任何效果——否则游标会因为一个 env 变动而倒退/前跳。
  it("honours the seed window on birth and ignores it forever after", async () => {
    const workerName = "seed-worker";
    const bornAt = new Date("2026-07-15T12:00:00.000Z");
    const epoch = new Date(0);
    expect((await repo.getOrCreateWatermark(workerName, bornAt, epoch)).lastTs).toEqual(epoch);

    const later = new Date("2026-07-16T12:00:00.000Z");
    const reseeded = await repo.getOrCreateWatermark(workerName, later, later);
    expect(reseeded.lastTs).toEqual(epoch);
  });

  // finishCycle 的 consecutiveFailures/lastError 传 undefined = 「本轮没动过裁判」⇒ 不碰这两列。
  // 曾经它无条件写 `?? 0` / `?? null`，而空轮也走 finishCycle ⇒ 上一次真实故障被擦干净。
  it("keeps the last real failure when a later cycle never touched the judge", async () => {
    const workerName = "empty-cycle-worker";
    const at = new Date("2026-07-15T05:00:00.000Z");
    const later = new Date("2026-07-15T05:15:00.000Z");
    const traceId = "a".repeat(32);
    await repo.getOrCreateWatermark(workerName, at);

    // 第一轮：裁判连挂 3 次，如实记账（finishCycle 顺带释放租约）
    expect(await repo.tryAcquireLease(workerName, "owner-1", at, 20 * 60_000)).toBe(true);
    await repo.finishCycle(workerName, "owner-1", {
      lastTs: at,
      lastTraceId: traceId,
      evaluatedIncrement: 0,
      now: at,
      consecutiveFailures: 3,
      lastError: "JudgeUnavailable: judge down",
    });
    expect((await repo.findWatermark(workerName))?.lastError).toBe("JudgeUnavailable: judge down");

    // 第二轮：0 候选 ⇒ 没动裁判 ⇒ 两个字段传 undefined ⇒ 不得擦掉上一次真实故障
    expect(await repo.tryAcquireLease(workerName, "owner-2", later, 20 * 60_000)).toBe(true);
    await repo.finishCycle(workerName, "owner-2", {
      lastTs: at,
      lastTraceId: traceId,
      evaluatedIncrement: 0,
      now: later,
    });
    const saved = await repo.findWatermark(workerName);
    expect(saved?.lastError).toBe("JudgeUnavailable: judge down");
    expect(saved?.consecutiveFailures).toBe(3);
    // 空轮仍是一次成功的轮次——lastSuccessAt 该走。断言它也钉住「这一轮真的写进去了」，
    // 否则 0 行更新会让上面两条断言因为「什么都没发生」而假绿。
    expect(saved?.lastSuccessAt).toEqual(later);
  });

  // ── 账本（游标的审计轨迹）────────────────────────────────────────────────

  // 按 judge_version 取——本文件多个用例都往同一张表写，读全表会让用例互相污染
  // （初版正是如此：另一个用例的行让这里从 3 变成 6）。一个用例只断言自己造的行。
  async function ledgerRows(judgeVersion: string, traceId?: string) {
    const { rows } = await pool.query<{
      target_trace_id: string;
      outcome: string;
      seen_count: number;
      last_error: string | null;
      agent_id: string;
    }>(
      traceId
        ? "SELECT * FROM eval_candidate_ledger WHERE judge_version=$1 AND target_trace_id=$2"
        : "SELECT * FROM eval_candidate_ledger WHERE judge_version=$1 ORDER BY trace_start_time",
      traceId ? [judgeVersion, traceId] : [judgeVersion],
    );
    return rows;
  }

  it("records every terminal outcome the worker produced, not just the skips", async () => {
    const workerName = "ledger-worker";
    const at = new Date("2026-07-15T06:00:00.000Z");
    await repo.getOrCreateWatermark(workerName, at);
    expect(await repo.tryAcquireLease(workerName, "owner-1", at, 20 * 60_000)).toBe(true);
    const entry = (id: string, outcome: string, lastError: string | null = null) => ({
      targetTraceId: id.repeat(32).slice(0, 32),
      traceStartTime: at,
      agentId: "agent-1",
      outcome,
      lastError,
    });
    await repo.finishCycle(workerName, "owner-1", {
      lastTs: at,
      lastTraceId: "1".repeat(32),
      evaluatedIncrement: 1,
      now: at,
      cursorMoved: true,
      judgeVersion: "online-v1",
      ledger: [
        entry("1", "success"),
        entry("2", "sampled_out"),
        entry("3", "processed_failed", "JudgeUnavailable: down"),
      ],
    });
    const rows = await ledgerRows("online-v1");
    // 记全 6 种（这里覆盖 3 种代表）——账本是唯一不依赖 span 投递的证据，
    // 与 codecrush_eval_targets 的差集正是丢包的量化手段。只记跳过拿不到这个能力。
    expect(rows.map((r) => r.outcome).sort()).toEqual([
      "processed_failed",
      "sampled_out",
      "success",
    ]);
    expect(rows.find((r) => r.outcome === "processed_failed")?.last_error).toBe(
      "JudgeUnavailable: down",
    );
    expect((await repo.findWatermark(workerName))?.lastCursorMoveAt).toEqual(at);
  });

  it("counts repeat sightings instead of duplicating the row", async () => {
    const workerName = "ledger-repeat-worker";
    const at = new Date("2026-07-15T07:00:00.000Z");
    const later = new Date("2026-07-15T07:15:00.000Z");
    const traceId = "7".repeat(32);
    await repo.getOrCreateWatermark(workerName, at);
    const cycle = async (now: Date, owner: string, outcome: string) => {
      expect(await repo.tryAcquireLease(workerName, owner, now, 20 * 60_000)).toBe(true);
      await repo.finishCycle(workerName, owner, {
        lastTs: at,
        lastTraceId: traceId,
        evaluatedIncrement: 0,
        now,
        judgeVersion: "online-v1",
        ledger: [{ targetTraceId: traceId, traceStartTime: at, agentId: "a", outcome }],
      });
    };
    // cap/circuit 前缀之后的候选会被重复扫到——那是既有的 continue 语义，不是 bug。
    // 账本必须累加 seen_count 而非插重复行（复合主键 (trace, judgeVersion) 保证）。
    await cycle(at, "owner-1", "success");
    await cycle(later, "owner-2", "already_scored");
    const rows = await ledgerRows("online-v1", traceId);
    expect(rows).toHaveLength(1);
    expect(rows[0].seen_count).toBe(2);
    // outcome 取最新——最后一次的判定才是当前事实
    expect(rows[0].outcome).toBe("already_scored");
  });

  it("keeps ledger and cursor atomic: a failed write advances neither", async () => {
    const workerName = "ledger-atomic-worker";
    const at = new Date("2026-07-15T08:00:00.000Z");
    await repo.getOrCreateWatermark(workerName, at);
    expect(await repo.tryAcquireLease(workerName, "owner-1", at, 20 * 60_000)).toBe(true);
    const before = await repo.findWatermark(workerName);

    // agent_id 超长 → 账本 INSERT 在事务内炸 → 游标推进必须一起回滚。
    // 崩在两者之间会造出「游标过了但没记账」，正是本设计要消灭的黑洞。
    await expect(
      repo.finishCycle(workerName, "owner-1", {
        lastTs: new Date("2026-07-15T09:00:00.000Z"),
        lastTraceId: "9".repeat(32),
        evaluatedIncrement: 1,
        now: at,
        cursorMoved: true,
        judgeVersion: "online-v1",
        ledger: [
          {
            targetTraceId: "9".repeat(32),
            traceStartTime: at,
            agentId: "x".repeat(200),
            outcome: "success",
          },
        ],
      }),
    ).rejects.toThrow();

    const after = await repo.findWatermark(workerName);
    expect(after?.lastTs).toEqual(before?.lastTs);
    expect(after?.lastTraceId).toBe(before?.lastTraceId);
    expect(after?.lastCursorMoveAt).toBeNull();
    expect(await ledgerRows("online-v1", "9".repeat(32))).toHaveLength(0);
  });

  it("refuses ledger entries without a judgeVersion", async () => {
    const workerName = "ledger-guard-worker";
    const at = new Date("2026-07-15T10:00:00.000Z");
    await repo.getOrCreateWatermark(workerName, at);
    await repo.tryAcquireLease(workerName, "owner-1", at, 20 * 60_000);
    await expect(
      repo.finishCycle(workerName, "owner-1", {
        lastTs: at,
        lastTraceId: "",
        evaluatedIncrement: 0,
        now: at,
        ledger: [{ targetTraceId: "b".repeat(32), traceStartTime: at, agentId: "a", outcome: "x" }],
      }),
    ).rejects.toThrow(/judgeVersion/);
  });

  it("leaves lastCursorMoveAt alone when the cursor did not move", async () => {
    const workerName = "ledger-idle-worker";
    const at = new Date("2026-07-15T11:00:00.000Z");
    await repo.getOrCreateWatermark(workerName, at);
    await repo.tryAcquireLease(workerName, "owner-1", at, 20 * 60_000);
    await repo.finishCycle(workerName, "owner-1", {
      lastTs: at,
      lastTraceId: "",
      evaluatedIncrement: 0,
      now: at,
      cursorMoved: false,
    });
    const saved = await repo.findWatermark(workerName);
    // 「跑过」与「走过」必须分开：空转一轮 lastRunAt 走、lastCursorMoveAt 不走
    expect(saved?.lastRunAt).toEqual(at);
    expect(saved?.lastCursorMoveAt).toBeNull();
  });
});
