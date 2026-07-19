/**
 * 迁移 0024（应用级上线门禁开关）的 Postgres 集成测试（RUN_DB_TESTS=1 门控，
 * 仿 eval-runs-active-slot.migration.spec.ts:26-46 的自包含形状）。
 *
 * 运行：`pnpm --filter @codecrush/backend test:db`（需先 CREATE DATABASE codecrush_mig_test）。
 *
 * ⚠️ 必须自包含（自己 resetSchema + 按 journal 重放迁移）：同套件里的其它迁移 spec 会
 * `DROP SCHEMA public CASCADE`，若本 spec 依赖「库里已经迁好了」的外部状态，跑单文件时绿、
 * 跑全套件时红（实测踩过：column "eval_gate_enabled" does not exist）。
 *
 * 本波最关键的一钉在第二个用例：**升级前就存在的应用行必须回填为 false**。
 * 这是「既有应用升级后发布行为逐字节不变」这条不变量的机器证明——空库里数一遍 0 行
 * 证明不了任何事（没有既有行可回填）。
 */
import { readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";
import { dbGate } from "./helpers/gated-suite";

const describeDb = dbGate();
jest.setTimeout(180_000);

const MIGRATIONS_DIR = join(__dirname, "..", "drizzle");
const GATE_TAG = "0024_eval_gate_switch";
const PRIOR_TAG = "0023_eval_run_active_slot";

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

async function seedApplication(pool: Pool, slug: string): Promise<string> {
  const rows = await pool.query(
    `INSERT INTO applications (slug, name, created_by, updated_by)
     VALUES ($1, $1, 't', 't') RETURNING id`,
    [slug],
  );
  return rows.rows[0].id as string;
}

describeDb("迁移 0024 应用级上线门禁开关（RUN_DB_TESTS=1）", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.MIGRATION_TEST_DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it("applications.eval_gate_enabled 存在、NOT NULL、默认 false", async () => {
    await resetSchema(pool);
    await applyMigrations(pool); // 全量，含 0024

    const { rows } = await pool.query(
      `SELECT column_name, is_nullable, column_default, data_type
         FROM information_schema.columns
        WHERE table_name = 'applications' AND column_name = 'eval_gate_enabled'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].is_nullable).toBe("NO");
    expect(rows[0].data_type).toBe("boolean");
    expect(rows[0].column_default).toBe("false");
  });

  it("升级前就存在的应用行回填为 false —— 既有应用发布行为零变化", async () => {
    await resetSchema(pool);
    await applyMigrations(pool, PRIOR_TAG); // 停在 0024 之前
    const legacyId = await seedApplication(pool, "legacy-app");

    await applyMigrationFile(pool, GATE_TAG); // 现在升级

    const { rows } = await pool.query(
      `SELECT eval_gate_enabled FROM applications WHERE id = $1`,
      [legacyId],
    );
    expect(rows).toHaveLength(1);
    // 关键：不是 NULL、不是 true——门禁对既有应用默认关闭（原型 §8「默认关(仅提示)」）
    expect(rows[0].eval_gate_enabled).toBe(false);

    // 全表零例外（含迁移后新插入的行走默认值）
    await seedApplication(pool, "post-upgrade-app");
    const all = await pool.query(
      `SELECT count(*)::int AS n FROM applications WHERE eval_gate_enabled IS DISTINCT FROM false`,
    );
    expect(all.rows[0].n).toBe(0);
  });

  it("新建应用默认关闭门禁（DEFAULT false 真实生效，不依赖应用层补值）", async () => {
    await resetSchema(pool);
    await applyMigrations(pool);
    const id = await seedApplication(pool, "fresh-app");

    const { rows } = await pool.query(
      `SELECT eval_gate_enabled FROM applications WHERE id = $1`,
      [id],
    );
    expect(rows[0].eval_gate_enabled).toBe(false);
  });
});
