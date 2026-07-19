/**
 * 迁移 0025（人工「立即评测」作业表）的 Postgres 集成测试（RUN_DB_TESTS=1 门控）。
 *
 * 本波最关键的一钉在第三条：**人工评测绝不进 eval_candidate_ledger**。
 * 账本记的是游标推进语义，人工旁路不推进游标；混进去会污染屏1 的
 * missedBreakdown / scoresNotPersisted 口径（countLedgerByOutcome 不按 workerName 过滤）。
 */
import { readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";
import { dbGate } from "./helpers/gated-suite";

const describeDb = dbGate();
jest.setTimeout(180_000);

// 必须自包含：同套件里的迁移 spec 会 DROP SCHEMA public CASCADE，
// 依赖「库里已经迁好了」会出现「单跑绿、全套件红」（本波已在 0024 上踩过一次）。
const MIGRATIONS_DIR = join(__dirname, "..", "drizzle");

function journalTags(): string[] {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  return journal.entries.map((e) => e.tag);
}

async function applyMigrations(pool: Pool): Promise<void> {
  for (const tag of journalTags()) {
    const text = readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8");
    for (const raw of text.split("--> statement-breakpoint")) {
      const stmt = raw.trim();
      if (stmt) await pool.query(stmt);
    }
  }
}

async function resetSchema(pool: Pool): Promise<void> {
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
}

describeDb("0025 eval_manual_score_jobs（RUN_DB_TESTS=1）", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.MIGRATION_TEST_DATABASE_URL });
    await resetSchema(pool);
    await applyMigrations(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("表存在且主键为 (target_trace_id, judge_version) —— 顺序也钉住", async () => {
    // 按 indkey 里的真实位置排序，不能按 attname 字母序：
    // 字母序下 (judge_version, target_trace_id) 与 (target_trace_id, judge_version) 无从区分，
    // 而复合主键的列序决定索引前缀能不能被 `WHERE target_trace_id = ?` 命中。
    const { rows } = await pool.query(
      `SELECT a.attname
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'eval_manual_score_jobs'::regclass AND i.indisprimary
        ORDER BY array_position(i.indkey::int2[], a.attnum)`,
    );
    expect(rows.map((r) => r.attname)).toEqual(["target_trace_id", "judge_version"]);
  });

  it("status/updated_at 索引存在 —— 这是 statement-breakpoint 失配时唯一会掉的对象", async () => {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'eval_manual_score_jobs_status_idx'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/\(status, updated_at\)/);
  });

  it("只给必填列时默认值生效（queued / 0 次尝试）", async () => {
    const trace = "f".repeat(32);
    await pool.query(
      `INSERT INTO eval_manual_score_jobs (target_trace_id, judge_version, requested_by)
       VALUES ($1,'online-v2','t@example.com')`,
      [trace],
    );
    const { rows } = await pool.query(
      `SELECT status, attempts, last_error FROM eval_manual_score_jobs WHERE target_trace_id = $1`,
      [trace],
    );
    expect(rows[0]).toMatchObject({ status: "queued", attempts: 0, last_error: null });
    await pool.query(`DELETE FROM eval_manual_score_jobs WHERE target_trace_id = $1`, [trace]);
  });

  it("status CHECK 只认四态", async () => {
    await expect(
      pool.query(
        `INSERT INTO eval_manual_score_jobs (target_trace_id, judge_version, status, requested_by)
         VALUES ($1,'online-v2','bogus','t@example.com')`,
        ["c".repeat(32)],
      ),
    ).rejects.toThrow(/eval_manual_score_jobs_status_check/);
  });

  it("与 eval_candidate_ledger 是两张独立表 —— 人工评测不进账本", async () => {
    const trace = "d".repeat(32);
    // 先种一条**别的** trace 的账本行：空库里数出 0 行证明不了任何事，
    // 必须证明「写作业表不会改变账本的行数」。
    await pool.query(
      `INSERT INTO eval_candidate_ledger
         (target_trace_id, judge_version, worker_name, outcome, trace_start_time, agent_id,
          first_seen_at, last_seen_at)
       VALUES ($1,'online-v2','worker-1','scored', now(), 'app-1', now(), now())`,
      ["9".repeat(32)],
    );
    const before = await pool.query(`SELECT count(*)::int AS n FROM eval_candidate_ledger`);

    const inserted = await pool.query(
      `INSERT INTO eval_manual_score_jobs (target_trace_id, judge_version, status, requested_by)
       VALUES ($1,'online-v2','queued','t@example.com')`,
      [trace],
    );
    // 证明这一行**真的写进去了**（否则下面的断言只是在为空表叫好）
    expect(inserted.rowCount).toBe(1);

    const after = await pool.query(`SELECT count(*)::int AS n FROM eval_candidate_ledger`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const mine = await pool.query(
      `SELECT count(*)::int AS n FROM eval_candidate_ledger WHERE target_trace_id = $1`,
      [trace],
    );
    expect(mine.rows[0].n).toBe(0);

    await pool.query(`DELETE FROM eval_manual_score_jobs WHERE target_trace_id = $1`, [trace]);
    await pool.query(`DELETE FROM eval_candidate_ledger WHERE target_trace_id = $1`, ["9".repeat(32)]);
  });

  it("同一 (trace, judgeVersion) 二次插入走主键冲突（重试靠 upsert 而非重复建行）", async () => {
    const trace = "e".repeat(32);
    const insert = () =>
      pool.query(
        `INSERT INTO eval_manual_score_jobs (target_trace_id, judge_version, status, requested_by)
         VALUES ($1,'online-v2','queued','t@example.com')`,
        [trace],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/eval_manual_score_jobs_pk/);
    await pool.query(`DELETE FROM eval_manual_score_jobs WHERE target_trace_id = $1`, [trace]);
  });
});
