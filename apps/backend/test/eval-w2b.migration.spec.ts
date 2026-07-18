/**
 * E-W2b 迁移 0022 的 Postgres 集成测试（RUN_DB_TESTS=1 门控，仿 prompts.migration.spec）。
 *
 * 验证：
 * ① gold_doc_ids → gold_doc_refs 回填（数量/docId 正确、docName 取自 documents、查不到用 ''）；
 * ② (run_id,case_version_id,repeat_index) 唯一索引存在，旧结果行 repeat_index 默认 1；
 * ③ 存在 queued run 时迁移 fail fast（RAISE）。
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
const W2B_TAG = "0022_eval_w2b";
const PRIOR_TAG = "0021_judge_scoring_v2";

function journalTags(): string[] {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  return journal.entries.map((e) => e.tag);
}

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
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
}

interface Fixture {
  docId: string;
  caseVersionId: string; // 有 gold_doc_ids（含一个不存在的 docId）
  emptyCaseVersionId: string; // gold_doc_ids 为空
  runId: string;
}

/** 预置 0021 形态数据：documents + eval_sets/cases/case_versions(gold_doc_ids) + 一条 done run 与结果行。 */
async function seedLegacy(pool: Pool): Promise<Fixture> {
  const modelId = (
    await pool.query(
      `INSERT INTO model_providers (type, protocol, name, base_url, api_key_enc)
       VALUES ('embedding', 'openai', 'emb', 'http://x', 'enc') RETURNING id`,
    )
  ).rows[0].id as string;
  const kbId = (
    await pool.query(
      `INSERT INTO knowledge_bases (name, chunk_template, embedding_model_id)
       VALUES ('kb1', 'general', $1) RETURNING id`,
      [modelId],
    )
  ).rows[0].id as string;
  const docId = (
    await pool.query(
      `INSERT INTO documents (kb_id, name, type, size, blob_key)
       VALUES ($1, '退款政策', 'pdf', 100, 'blob1') RETURNING id`,
      [kbId],
    )
  ).rows[0].id as string;
  const ghostDocId = "99999999-9999-4999-8999-999999999999";

  const setId = (
    await pool.query(
      `INSERT INTO eval_sets (name, created_by) VALUES ('售后核心', 't@test') RETURNING id`,
    )
  ).rows[0].id as string;
  const caseId = (
    await pool.query(
      `INSERT INTO eval_cases (set_id, status) VALUES ($1, 'reviewed') RETURNING id`,
      [setId],
    )
  ).rows[0].id as string;
  const caseVersionId = (
    await pool.query(
      `INSERT INTO eval_case_versions (case_id, version, question, gold_doc_ids)
       VALUES ($1, 1, '课程可以退款吗', ARRAY[$2::uuid, $3::uuid]) RETURNING id`,
      [caseId, docId, ghostDocId],
    )
  ).rows[0].id as string;
  const emptyCaseVersionId = (
    await pool.query(
      `INSERT INTO eval_case_versions (case_id, version, question)
       VALUES ($1, 2, '无 gold 用例') RETURNING id`,
      [caseId],
    )
  ).rows[0].id as string;

  const runId = (
    await pool.query(
      `INSERT INTO eval_runs (set_id, application_id, config_version_id, judge_model_id,
         embedding_model_id, status, case_version_snapshot, created_by)
       VALUES ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
         'done', '[]'::jsonb, 't@test') RETURNING id`,
      [setId],
    )
  ).rows[0].id as string;
  await pool.query(
    `INSERT INTO eval_run_results (run_id, case_version_id, seq, verdict)
     VALUES ($1, $2, 1, 'pass')`,
    [runId, caseVersionId],
  );

  return { docId, caseVersionId, emptyCaseVersionId, runId };
}

describeDb("eval w2b 迁移 0022（RUN_DB_TESTS=1）", () => {
  let pool: Pool;
  let fx: Fixture;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.MIGRATION_TEST_DATABASE_URL });
    await resetSchema(pool);
    await applyMigrations(pool, PRIOR_TAG);
    fx = await seedLegacy(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("gold_doc_ids → gold_doc_refs 回填：数量/docId 正确、docName 取自 documents，查不到用 ''", async () => {
    await applyMigrationFile(pool, W2B_TAG);

    const { rows } = await pool.query(
      `SELECT gold_doc_refs FROM eval_case_versions WHERE id = $1`,
      [fx.caseVersionId],
    );
    const refs = rows[0].gold_doc_refs as Array<{
      docId: string;
      chunkId: string | null;
      docName: string;
      section: string | null;
    }>;
    expect(refs).toHaveLength(2);
    const known = refs.find((r) => r.docId === fx.docId);
    expect(known).toBeDefined();
    expect(known?.docName).toBe("退款政策");
    expect(known?.chunkId).toBeNull();
    expect(known?.section).toBeNull();
    const ghost = refs.find((r) => r.docId !== fx.docId);
    expect(ghost?.docName).toBe("");

    const empty = await pool.query(`SELECT gold_doc_refs FROM eval_case_versions WHERE id = $1`, [
      fx.emptyCaseVersionId,
    ]);
    expect(empty.rows[0].gold_doc_refs).toEqual([]);
  });

  it("gold_doc_ids 列已删除", async () => {
    const col = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'eval_case_versions' AND column_name = 'gold_doc_ids'`,
    );
    expect(col.rows).toHaveLength(0);
  });

  it("唯一索引改为 (run_id, case_version_id, repeat_index)，旧行 repeat_index 默认 1", async () => {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'eval_run_results_run_case_unique'`,
    );
    expect(rows[0].indexdef).toMatch(/repeat_index/);
    const r = await pool.query(`SELECT repeat_index FROM eval_run_results WHERE run_id = $1`, [
      fx.runId,
    ]);
    expect(r.rows[0].repeat_index).toBe(1);
    // 同 (run, case) 不同 repeat_index 可共存
    await pool.query(
      `INSERT INTO eval_run_results (run_id, case_version_id, seq, verdict, repeat_index)
       VALUES ($1, $2, 1, 'pass', 2)`,
      [fx.runId, fx.caseVersionId],
    );
    // 同三元组重复 → 冲突
    await expect(
      pool.query(
        `INSERT INTO eval_run_results (run_id, case_version_id, seq, verdict, repeat_index)
         VALUES ($1, $2, 1, 'pass', 2)`,
        [fx.runId, fx.caseVersionId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("存在 queued/running run 时迁移 fail fast（RAISE）", async () => {
    await resetSchema(pool);
    await applyMigrations(pool, PRIOR_TAG);
    const setId = (
      await pool.query(
        `INSERT INTO eval_sets (name, created_by) VALUES ('x', 't') RETURNING id`,
      )
    ).rows[0].id as string;
    await pool.query(
      `INSERT INTO eval_runs (set_id, application_id, config_version_id, judge_model_id,
         embedding_model_id, status, case_version_snapshot, created_by)
       VALUES ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
         'queued', '[]'::jsonb, 't')`,
      [setId],
    );
    await expect(applyMigrationFile(pool, W2B_TAG)).rejects.toThrow(/blocked/);
  });
});
