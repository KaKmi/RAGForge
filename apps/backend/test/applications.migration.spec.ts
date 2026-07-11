import { readFileSync } from "fs";
import { join } from "path";
import { ApplicationConfigFieldsSchema } from "@codecrush/contracts";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { runBackfill, verifyBackfill } from "../src/db/backfill-applications";

const enabled = process.env.RUN_DB_TESTS === "1" && !!process.env.MIGRATION_TEST_DATABASE_URL;
const describeDb = enabled ? describe : describe.skip;
const MIGRATIONS_DIR = join(__dirname, "..", "drizzle");
const ADDITIVE_TAG = "0013_nervous_klaw";

jest.setTimeout(180_000);

function journalTags(): string[] {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  return journal.entries.map((entry) => entry.tag);
}

async function resetAndMigrate(pool: Pool): Promise<void> {
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  for (const tag of journalTags()) {
    const text = readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8");
    for (const raw of text.split("--> statement-breakpoint")) {
      if (raw.trim()) await pool.query(raw.trim());
    }
    if (tag === ADDITIVE_TAG) return;
  }
  throw new Error(`journal 中不存在 ${ADDITIVE_TAG}`);
}

describeDb("applications migration + backfill", () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle>;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.MIGRATION_TEST_DATABASE_URL });
    await resetAndMigrate(pool);
    db = drizzle(pool);

    ids.model = (
      await pool.query(`INSERT INTO model_providers
        (type, protocol, name, base_url, api_key_enc, params, enabled)
        VALUES ('llm','openai_compat','legacy-llm','http://localhost','enc','{}',true)
        RETURNING id`)
    ).rows[0].id;
    ids.prompt = (
      await pool.query(
        `INSERT INTO prompts (name,node,updated_by) VALUES ('legacy-reply','reply','legacy') RETURNING id`,
      )
    ).rows[0].id;
    ids.promptVersion = (
      await pool.query(
        `INSERT INTO prompt_versions
          (prompt_id,version,body,variables,author,contract_version,compile_status,compile_errors)
         VALUES ($1,1,'{query}','["query"]','legacy',1,'ok','[]') RETURNING id`,
        [ids.prompt],
      )
    ).rows[0].id;
    ids.kb = (
      await pool.query(
        `INSERT INTO knowledge_bases (name,"desc",chunk_template,embedding_model_id,status)
         VALUES ('legacy-kb','','general',$1,'ready') RETURNING id`,
        [ids.model],
      )
    ).rows[0].id;
    ids.agent = (
      await pool.query(
        `INSERT INTO agents (name,"desc",enabled,updated_by) VALUES ('legacy-app','',true,'legacy') RETURNING id`,
      )
    ).rows[0].id;
    const nodeParams = {
      rewrite: { freedom: "balance", temperature: 0.7, topP: 0.9 },
      intent: { freedom: "balance", temperature: 0.7, topP: 0.9 },
      reply: { freedom: "balance", temperature: 0.7, topP: 0.9 },
      fallback: { freedom: "balance", temperature: 0.7, topP: 0.9 },
    };
    ids.version = (
      await pool.query(
        `INSERT INTO agent_config_versions
          (agent_id,version,status,gen_model_id,prompt_rewrite_ver_id,prompt_intent_ver_id,
           prompt_reply_ver_id,prompt_fallback_ver_id,node_params,top_k,top_n,threshold,
           multi_recall,vec_weight,fallback_human,created_by)
         VALUES ($1,1,'published',$2,$3,$3,$3,$3,$4,20,5,0.4,true,0.7,true,'legacy') RETURNING id`,
        [ids.agent, ids.model, ids.promptVersion, JSON.stringify(nodeParams)],
      )
    ).rows[0].id;
    await pool.query(`INSERT INTO agent_config_version_kbs (version_id,kb_id) VALUES ($1,$2)`, [
      ids.version,
      ids.kb,
    ]);
    await pool.query(`UPDATE agents SET current_version_id=$1 WHERE id=$2`, [
      ids.version,
      ids.agent,
    ]);
    ids.agentWithoutProduction = (
      await pool.query(
        `INSERT INTO agents (name,"desc",enabled,updated_by)
         VALUES ('legacy-draft-app','',true,'legacy') RETURNING id`,
      )
    ).rows[0].id;
    ids.versionWithoutProduction = (
      await pool.query(
        `INSERT INTO agent_config_versions
          (agent_id,version,status,gen_model_id,prompt_rewrite_ver_id,prompt_intent_ver_id,
           prompt_reply_ver_id,prompt_fallback_ver_id,node_params,top_k,top_n,threshold,
           multi_recall,vec_weight,fallback_human,created_by)
         VALUES ($1,1,'draft',$2,$3,$3,$3,$3,$4,20,5,0.4,true,0.7,true,'legacy') RETURNING id`,
        [ids.agentWithoutProduction, ids.model, ids.promptVersion, JSON.stringify(nodeParams)],
      )
    ).rows[0].id;
    await pool.query(`INSERT INTO agent_config_version_kbs (version_id,kb_id) VALUES ($1,$2)`, [
      ids.versionWithoutProduction,
      ids.kb,
    ]);
  });

  afterAll(async () => pool?.end());

  it("creates only the three M7a tables while retaining legacy tables", async () => {
    const result = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name LIKE 'application%' ORDER BY table_name`,
    );
    expect(result.rows.map((row) => row.table_name)).toEqual([
      "application_config_version_kbs",
      "application_config_versions",
      "applications",
    ]);
    expect(result.rows.some((row) => row.table_name === "application_release_checks")).toBe(false);
    expect((await pool.query(`SELECT 1 FROM agents`)).rowCount).toBe(2);
  });

  it("maps legacy identities, pointers, versions and snapshots idempotently", async () => {
    expect(await runBackfill(db)).toEqual({ applications: 2, versions: 2, kbs: 2 });
    expect(await runBackfill(db)).toEqual({ applications: 0, versions: 0, kbs: 0 });
    await pool.query(
      `DELETE FROM application_config_version_kbs WHERE config_version_id=$1 AND kb_id=$2`,
      [ids.version, ids.kb],
    );
    expect(await runBackfill(db)).toEqual({ applications: 0, versions: 0, kbs: 1 });
    const app = (await pool.query(`SELECT * FROM applications WHERE id=$1`, [ids.agent])).rows[0];
    expect(app.slug).toBe(ids.agent);
    expect(app.production_config_version_id).toBe(ids.version);
    const draftApp = (
      await pool.query(`SELECT * FROM applications WHERE id=$1`, [ids.agentWithoutProduction])
    ).rows[0];
    expect(draftApp.production_config_version_id).toBeNull();
    const version = (
      await pool.query(`SELECT * FROM application_config_versions WHERE id=$1`, [ids.version])
    ).rows[0];
    expect(version.rewrite_model_id).toBe(ids.model);
    expect(version.prompt_reply_version_id).toBe(ids.promptVersion);
    expect(version.node_params.reply).toEqual({ freedom: "balance", temperature: 0.7, topP: 0.9 });
    expect(version.retrieval_params).toMatchObject({
      schemaVersion: 1,
      topK: 20,
      topN: 5,
      hybridEnabled: true,
      vectorWeight: 0.7,
      rerankEnabled: false,
      rerankThreshold: 0.4,
    });
  });

  it("produces strict contract-valid config snapshots and verifies completion", async () => {
    const version = (
      await pool.query(`SELECT * FROM application_config_versions WHERE id=$1`, [ids.version])
    ).rows[0];
    expect(() =>
      ApplicationConfigFieldsSchema.parse({
        kbIds: [ids.kb],
        nodes: {
          rewrite: {
            ...version.node_params.rewrite,
            promptVersionId: version.prompt_rewrite_version_id,
            modelId: version.rewrite_model_id,
          },
          intent: {
            ...version.node_params.intent,
            promptVersionId: version.prompt_intent_version_id,
            modelId: version.intent_model_id,
          },
          reply: {
            ...version.node_params.reply,
            promptVersionId: version.prompt_reply_version_id,
            modelId: version.reply_model_id,
          },
          fallback: {
            ...version.node_params.fallback,
            promptVersionId: version.prompt_fallback_version_id,
            modelId: version.fallback_model_id,
          },
        },
        retrieval: version.retrieval_params,
        fallback: version.fallback_params,
      }),
    ).not.toThrow();
    expect(await verifyBackfill(db)).toEqual({ ok: true, problems: [] });
    await pool.query(`UPDATE applications SET description='wrong' WHERE id=$1`, [ids.agent]);
    const invalid = await verifyBackfill(db);
    expect(invalid.ok).toBe(false);
    expect(invalid.problems).toContain("applications 存在与 legacy identity 映射不一致的行");
    await pool.query(`UPDATE applications SET description='' WHERE id=$1`, [ids.agent]);
    await pool.query(
      `UPDATE applications SET updated_at=updated_at + interval '1 second' WHERE id=$1`,
      [ids.agent],
    );
    expect((await verifyBackfill(db)).problems).toContain(
      "applications 存在与 legacy identity 映射不一致的行",
    );
    await pool.query(
      `UPDATE applications target SET updated_at=source.updated_at
       FROM agents source WHERE target.id=source.id AND target.id=$1`,
      [ids.agent],
    );
    await pool.query(`UPDATE application_config_versions SET config_schema_version=2 WHERE id=$1`, [
      ids.version,
    ]);
    expect((await verifyBackfill(db)).problems).toContain(
      `配置版本 ${ids.version} 与 legacy 映射不一致`,
    );
    await pool.query(`UPDATE application_config_versions SET config_schema_version=1 WHERE id=$1`, [
      ids.version,
    ]);
  });

  it("keeps referenced prompts restricted and cascades application-owned rows", async () => {
    await expect(
      pool.query(`DELETE FROM prompt_versions WHERE id=$1`, [ids.promptVersion]),
    ).rejects.toMatchObject({ code: "23503" });
    await pool.query(`DELETE FROM applications WHERE id=$1`, [ids.agent]);
    expect(
      (await pool.query(`SELECT 1 FROM application_config_versions WHERE id=$1`, [ids.version]))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query(
          `SELECT 1 FROM application_config_version_kbs WHERE config_version_id=$1`,
          [ids.version],
        )
      ).rowCount,
    ).toBe(0);
  });
});
