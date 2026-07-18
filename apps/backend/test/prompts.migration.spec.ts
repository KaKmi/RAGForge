/**
 * 012 Story 2：Prompt 迁移/backfill 的 Postgres 集成测试。
 *
 * 双闸保护（绝不指向共享开发库）：
 * - RUN_DB_TESTS=1 显式开启（默认 skip，CI/本地普通 `pnpm test` 不触发）；
 * - 连接串取自专用 MIGRATION_TEST_DATABASE_URL（不是 DATABASE_URL），指向一次性库，
 *   setup 会 DROP SCHEMA public CASCADE。
 *
 * 运行（Git Bash / WSL）：
 *   RUN_DB_TESTS=1 \
 *   MIGRATION_TEST_DATABASE_URL=postgres://codecrush:codecrush@localhost:5432/codecrush_mig_test \
 *     pnpm --filter @codecrush/backend exec jest test/prompts.migration.spec.ts
 * 或 `pnpm --filter @codecrush/backend test:db`（cross-env 已设 RUN_DB_TESTS，需自行导出连接串；
 * 库需先建：`CREATE DATABASE codecrush_mig_test`，与 infra postgres 同实例即可）。
 */
import { readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { BACKFILL_ACTOR, runBackfill, verifyBackfill } from "../src/db/backfill-prompt-contracts";
import { dbGate } from "./helpers/gated-suite";

const describeDb = dbGate();

jest.setTimeout(180_000);

const MIGRATIONS_DIR = join(__dirname, "..", "drizzle");
/** Story 2 的加法迁移；Story 4 的清理迁移在其后追加并被 applyMigrations(upToTag) 分段控制 */
const ADDITIVE_TAG = "0011_pink_falcon";
/** Story 4 的破坏性清理迁移（带 DO $$ 前置断言） */
const CLEANUP_TAG = "0012_charming_sphinx";

function journalTags(): string[] {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  return journal.entries.map((e) => e.tag);
}

/** 按 journal 顺序施加迁移；upToTag 含端点，之后的迁移不施加（供分段验证 backfill 门禁） */
async function applyMigrations(pool: Pool, upToTag?: string): Promise<void> {
  for (const tag of journalTags()) {
    const text = readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8");
    for (const raw of text.split("--> statement-breakpoint")) {
      const stmt = raw.trim();
      if (stmt) await pool.query(stmt);
    }
    if (tag === upToTag) return;
  }
  if (upToTag) throw new Error(`journal 中不存在迁移 ${upToTag}`);
}

/** 单独施加某个迁移文件（分段验证清理门禁用） */
async function applyMigrationFile(pool: Pool, tag: string): Promise<void> {
  const text = readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8");
  for (const raw of text.split("--> statement-breakpoint")) {
    const stmt = raw.trim();
    if (stmt) await pool.query(stmt);
  }
}

async function resetSchema(pool: Pool): Promise<void> {
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
  // chunks 表用 pgvector 类型；DROP SCHEMA 会连扩展对象一起删，须重建
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
}

interface LegacyFixture {
  promptA: string; // reply 节点：v1 draft / v2 prod / v3 archived
  a1: string;
  a2: string;
  a3: string;
  promptB: string; // rewrite 节点：仅 v1 draft
  b1: string;
}

/** 显式 legacy 三态数据（0011 加法迁移后 compile_status 为空 = 未 backfill 的旧数据形态） */
async function seedLegacy(pool: Pool): Promise<LegacyFixture> {
  const prompt = async (name: string, node: string) =>
    (
      await pool.query(
        `INSERT INTO prompts (name, node, updated_by) VALUES ($1, $2, 'legacy@test') RETURNING id`,
        [name, node],
      )
    ).rows[0].id as string;
  const version = async (promptId: string, v: number, body: string, status: string) =>
    (
      await pool.query(
        `INSERT INTO prompt_versions (prompt_id, version, body, variables, author, status)
         VALUES ($1, $2, $3, '[]'::jsonb, 'legacy@test', $4) RETURNING id`,
        [promptId, v, body, status],
      )
    ).rows[0].id as string;

  const promptA = await prompt("legacy-reply", "reply");
  const a1 = await version(promptA, 1, "草稿版 {query}", "draft");
  const a2 = await version(promptA, 2, "生产版 {query} {retrievalContext}", "prod");
  const a3 = await version(promptA, 3, "含未知变量 {nonexistent_var}", "archived");
  await pool.query(`UPDATE prompts SET current_version_id = $1 WHERE id = $2`, [a2, promptA]);

  const promptB = await prompt("legacy-rewrite", "rewrite");
  const b1 = await version(promptB, 1, "改写 {query}", "draft");
  return { promptA, a1, a2, a3, promptB, b1 };
}

describeDb("prompts 迁移 + backfill（RUN_DB_TESTS=1）", () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle>;
  let fx: LegacyFixture;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.MIGRATION_TEST_DATABASE_URL });
    await resetSchema(pool);
    await applyMigrations(pool, ADDITIVE_TAG);
    db = drizzle(pool);
    fx = await seedLegacy(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("加法迁移后 legacy 行保留，新列可空/默认", async () => {
    const { rows } = await pool.query(
      `SELECT status, contract_version, compile_status, compile_errors
       FROM prompt_versions WHERE prompt_id = $1 ORDER BY version`,
      [fx.promptA],
    );
    expect(rows.map((r) => r.status)).toEqual(["draft", "prod", "archived"]);
    for (const r of rows) {
      expect(r.contract_version).toBe(1);
      expect(r.compile_status).toBeNull();
      expect(r.compile_errors).toBeNull();
    }
  });

  it("backfill 补齐编译元数据 + prod→production 标签，重复运行幂等", async () => {
    const first = await runBackfill(db);
    expect(first.compiled).toBe(4);
    expect(first.tagged).toBe(1);

    const second = await runBackfill(db);
    expect(second.compiled).toBe(0);
    expect(second.tagged).toBe(0);

    const verification = await verifyBackfill(db);
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);

    // 共享编译器的真实结果：合法 body → ok；未知变量 → has_errors 且 issues 非空
    const { rows } = await pool.query(
      `SELECT version, compile_status, compile_errors FROM prompt_versions
       WHERE prompt_id = $1 ORDER BY version`,
      [fx.promptA],
    );
    expect(rows[0].compile_status).toBe("ok");
    expect(rows[1].compile_status).toBe("ok");
    expect(rows[2].compile_status).toBe("has_errors");
    expect(rows[2].compile_errors[0].code).toBe("UNKNOWN_VARIABLE");

    // 恰一个 production 标签，指向旧 prod 版本；draft/archived 无标签
    const tags = await pool.query(
      `SELECT prompt_version_id, name, created_by FROM prompt_version_tags WHERE prompt_id = $1`,
      [fx.promptA],
    );
    expect(tags.rows).toHaveLength(1);
    expect(tags.rows[0].name).toBe("production");
    expect(tags.rows[0].prompt_version_id).toBe(fx.a2);
    expect(tags.rows[0].created_by).toBe(BACKFILL_ACTOR);
    const tagsB = await pool.query(
      `SELECT 1 FROM prompt_version_tags WHERE prompt_id = $1`,
      [fx.promptB],
    );
    expect(tagsB.rows).toHaveLength(0);
  });

  it("同名标签大小写不敏感唯一（lower(name) 表达式索引）", async () => {
    await pool.query(
      `INSERT INTO prompt_version_tags (prompt_id, prompt_version_id, name, created_by)
       VALUES ($1, $2, 'alpha', 't@test')`,
      [fx.promptA, fx.a1],
    );
    await expect(
      pool.query(
        `INSERT INTO prompt_version_tags (prompt_id, prompt_version_id, name, created_by)
         VALUES ($1, $2, 'ALPHA', 't@test')`,
        [fx.promptA, fx.a2],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("复合 FK 拒绝把标签指向别的 Prompt 的版本", async () => {
    await expect(
      pool.query(
        `INSERT INTO prompt_version_tags (prompt_id, prompt_version_id, name, created_by)
         VALUES ($1, $2, 'cross', 't@test')`,
        [fx.promptA, fx.b1],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("并发移动同名标签：ON CONFLICT upsert 后恰余一行", async () => {
    const upsert = (versionId: string) =>
      pool.query(
        `INSERT INTO prompt_version_tags (prompt_id, prompt_version_id, name, created_by)
         VALUES ($1, $2, 'race', 't@test')
         ON CONFLICT (prompt_id, lower(name))
         DO UPDATE SET prompt_version_id = excluded.prompt_version_id,
                       created_at = now(), created_by = excluded.created_by`,
        [fx.promptA, versionId],
      );
    await Promise.all([upsert(fx.a1), upsert(fx.a2), upsert(fx.a3)]);
    const { rows } = await pool.query(
      `SELECT prompt_version_id FROM prompt_version_tags WHERE prompt_id = $1 AND name = 'race'`,
      [fx.promptA],
    );
    expect(rows).toHaveLength(1);
    expect([fx.a1, fx.a2, fx.a3]).toContain(rows[0].prompt_version_id);
  });

  it("级联：删版本随删标签；删 Prompt 随删版本与标签", async () => {
    // 删 a1（携带 alpha 标签）→ 标签级联消失，其他标签保留
    await pool.query(`DELETE FROM prompt_versions WHERE id = $1`, [fx.a1]);
    const afterVersionDelete = await pool.query(
      `SELECT name FROM prompt_version_tags WHERE prompt_id = $1 ORDER BY name`,
      [fx.promptA],
    );
    expect(afterVersionDelete.rows.map((r) => r.name)).not.toContain("alpha");

    // 删 promptA → 版本与标签全部级联消失
    await pool.query(`DELETE FROM prompts WHERE id = $1`, [fx.promptA]);
    const versions = await pool.query(`SELECT 1 FROM prompt_versions WHERE prompt_id = $1`, [
      fx.promptA,
    ]);
    const tags = await pool.query(`SELECT 1 FROM prompt_version_tags WHERE prompt_id = $1`, [
      fx.promptA,
    ]);
    expect(versions.rows).toHaveLength(0);
    expect(tags.rows).toHaveLength(0);
  });
});

describeDb("0012 清理迁移门禁（Story 4）", () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle>;
  let fx: LegacyFixture;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.MIGRATION_TEST_DATABASE_URL });
    await resetSchema(pool);
    await applyMigrations(pool, ADDITIVE_TAG);
    db = drizzle(pool);
    fx = await seedLegacy(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("backfill 未完成的故意残缺 fixture → DO $$ 前置断言 RAISE，旧列保留", async () => {
    await expect(applyMigrationFile(pool, CLEANUP_TAG)).rejects.toThrow(/0012 前置失败/);
    // 迁移未生效：status 列仍存在
    const col = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'prompt_versions' AND column_name = 'status'`,
    );
    expect(col.rows).toHaveLength(1);
  });

  it("backfill 完成后 → 0012 成功：旧列/索引消失，compile 列 NOT NULL", async () => {
    await runBackfill(db);
    const verification = await verifyBackfill(db);
    expect(verification.ok).toBe(true);

    await applyMigrationFile(pool, CLEANUP_TAG);

    const cols = await pool.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name IN ('prompt_versions', 'prompts')
         AND column_name IN ('status', 'current_version_id', 'compile_status', 'compile_errors')`,
    );
    const byName = new Map(cols.rows.map((r) => [r.column_name, r.is_nullable]));
    expect(byName.has("status")).toBe(false);
    expect(byName.has("current_version_id")).toBe(false);
    expect(byName.get("compile_status")).toBe("NO");
    expect(byName.get("compile_errors")).toBe("NO");

    const idx = await pool.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'prompt_versions_prompt_id_status_idx'`,
    );
    expect(idx.rows).toHaveLength(0);

    // 数据完整保留：production 标签仍指向旧 prod 版本
    const tag = await pool.query(
      `SELECT prompt_version_id FROM prompt_version_tags WHERE prompt_id = $1 AND name = 'production'`,
      [fx.promptA],
    );
    expect(tag.rows[0].prompt_version_id).toBe(fx.a2);

    // NOT NULL 收紧生效：缺 compile_status 的插入被拒绝
    await expect(
      pool.query(
        `INSERT INTO prompt_versions (prompt_id, version, body, variables, author)
         VALUES ($1, 99, 'x', '[]'::jsonb, 't@test')`,
        [fx.promptA],
      ),
    ).rejects.toMatchObject({ code: "23502" });
  });
});
