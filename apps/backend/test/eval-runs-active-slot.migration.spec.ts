/**
 * 迁移 0023（全局活跃槽位唯一索引）的 Postgres 集成测试（RUN_DB_TESTS=1 门控，
 * 仿 eval-w2b.migration.spec.ts:31-49 的形状）。
 *
 * 运行：`pnpm --filter @codecrush/backend test:db`（需先 CREATE DATABASE codecrush_mig_test）。
 */
import { readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";
import { dbGate } from "./helpers/gated-suite";

const describeDb = dbGate();
jest.setTimeout(180_000);

const MIGRATIONS_DIR = join(__dirname, "..", "drizzle");
const SLOT_TAG = "0023_eval_run_active_slot";
const PRIOR_TAG = "0022_eval_w2b";

function journalTags(): string[] {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  return journal.entries.map((e) => e.tag);
}

async function applyMigrationFile(pool: Pool, tag: string): Promise<void> {
  const text = readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8");
  for (const raw of text.split("--> statement-breakpoint")) {
    const stmt = raw.trim();
    if (stmt) await pool.query(stmt);
  }
}

async function applyMigrations(pool: Pool, upToTag?: string): Promise<void> {
  for (const tag of journalTags()) {
    await applyMigrationFile(pool, tag);
    if (tag === upToTag) return;
  }
  if (upToTag) throw new Error(`journal 中不存在迁移 ${upToTag}`);
}

async function resetSchema(pool: Pool): Promise<void> {
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
}

async function seedSet(pool: Pool): Promise<string> {
  const rows = await pool.query(
    `INSERT INTO eval_sets (name, created_by) VALUES ('slot', 't') RETURNING id`,
  );
  return rows.rows[0].id as string;
}

async function seedRun(pool: Pool, setId: string, status: string): Promise<string> {
  const rows = await pool.query(
    `INSERT INTO eval_runs (set_id, application_id, config_version_id, judge_model_id,
       embedding_model_id, status, case_version_snapshot, created_by)
     VALUES ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
       gen_random_uuid(), $2, '[]'::jsonb, 't') RETURNING id`,
    [setId, status],
  );
  return rows.rows[0].id as string;
}

describeDb("迁移 0023 全局活跃槽位唯一索引（RUN_DB_TESTS=1）", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.MIGRATION_TEST_DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it("库里已有 1 条活跃 run 时迁移照常成功（单条与唯一索引相容）", async () => {
    await resetSchema(pool);
    await applyMigrations(pool, PRIOR_TAG);
    const setId = await seedSet(pool);
    await seedRun(pool, setId, "running");

    await applyMigrationFile(pool, SLOT_TAG);

    const idx = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'eval_runs_single_active_unique'`,
    );
    expect(idx.rows).toHaveLength(1);
    expect(idx.rows[0].indexdef).toMatch(/UNIQUE/);
    // 部分索引谓词必须只覆盖活跃两态，否则终态 run 也会互斥 → 第二次评测永远发不起来
    expect(idx.rows[0].indexdef).toMatch(/WHERE .*queued.*running/s);
  });

  it("库里已有 2 条活跃 run 时迁移 fail-fast，且**不改动**任何业务数据", async () => {
    await resetSchema(pool);
    await applyMigrations(pool, PRIOR_TAG);
    const setId = await seedSet(pool);
    const a = await seedRun(pool, setId, "queued");
    const b = await seedRun(pool, setId, "running");

    // 报错必须带条数，让操作者知道现场有几条要处理。
    // 断言锚在 RAISE 的原文上而**不是**裸 `/2/`：后者会被 ENOENT（路径里的 "0023" 含 2）
    // 之类的**任何**错误满足 —— 那样这条用例会在迁移文件被删掉时依然「绿」，
    // 即为了错误的理由通过。
    await expect(applyMigrationFile(pool, SLOT_TAG)).rejects.toThrow(/存在 2 条活跃 eval_runs/);

    // 关键：迁移不得悄悄改业务数据（不得把多余的 run 自动收成 failed）
    const rows = await pool.query(
      `SELECT id, status FROM eval_runs WHERE id = ANY($1::uuid[]) ORDER BY status`,
      [[a, b]],
    );
    expect(rows.rows.map((r) => r.status)).toEqual(["queued", "running"]);
  });

  it("迁移后：终态 run 不占槽位，活跃 run 至多 1 条", async () => {
    await resetSchema(pool);
    await applyMigrations(pool); // 全量，含 0023
    const setId = await seedSet(pool);

    // 终态可以有任意多条
    await seedRun(pool, setId, "done");
    await seedRun(pool, setId, "failed");
    await seedRun(pool, setId, "done");

    // 活跃只能 1 条
    await seedRun(pool, setId, "queued");
    await expect(seedRun(pool, setId, "running")).rejects.toMatchObject({
      code: "23505",
      constraint: "eval_runs_single_active_unique",
    });
  });
});
