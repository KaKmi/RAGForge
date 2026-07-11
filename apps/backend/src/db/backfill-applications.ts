import "dotenv/config";
import { ApplicationConfigFieldsSchema, type ApplicationConfigFields } from "@codecrush/contracts";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  applicationConfigVersionKbs,
  applicationConfigVersions,
  applications,
} from "../modules/applications/schema";

type DB = ReturnType<typeof drizzle>;

interface LegacyVersion {
  id: string;
  agent_id: string;
  version: number;
  gen_model_id: string;
  rerank_model_id: string | null;
  prompt_rewrite_ver_id: string;
  prompt_intent_ver_id: string;
  prompt_reply_ver_id: string;
  prompt_fallback_ver_id: string;
  node_params: Record<
    string,
    {
      freedom: ApplicationConfigFields["nodes"]["reply"]["freedom"];
      temperature: number;
      topP: number;
    }
  >;
  top_k: number;
  top_n: number;
  threshold: number;
  multi_recall: boolean;
  vec_weight: number | null;
  fallback_human: boolean;
  note: string | null;
  created_by: string;
  created_at: Date | string;
}

function mapVersion(row: LegacyVersion, kbIds: string[]): ApplicationConfigFields {
  const node = (name: "rewrite" | "intent" | "reply" | "fallback", promptVersionId: string) => ({
    promptVersionId,
    modelId: row.gen_model_id,
    freedom: row.node_params[name].freedom,
    temperature: row.node_params[name].temperature,
    topP: row.node_params[name].topP,
  });
  return ApplicationConfigFieldsSchema.parse({
    kbIds,
    nodes: {
      rewrite: node("rewrite", row.prompt_rewrite_ver_id),
      intent: node("intent", row.prompt_intent_ver_id),
      reply: node("reply", row.prompt_reply_ver_id),
      fallback: node("fallback", row.prompt_fallback_ver_id),
    },
    retrieval: {
      schemaVersion: 1,
      topK: row.top_k,
      topN: row.top_n,
      hybridEnabled: row.multi_recall,
      vectorWeight: row.vec_weight ?? 0.5,
      rerankEnabled: row.rerank_model_id !== null,
      ...(row.rerank_model_id ? { rerankModelId: row.rerank_model_id } : {}),
      rerankThreshold: row.threshold,
    },
    fallback: { toHuman: row.fallback_human },
  });
}

function persistedNodeParams(config: ApplicationConfigFields) {
  const pick = (node: ApplicationConfigFields["nodes"]["reply"]) => ({
    freedom: node.freedom,
    temperature: node.temperature,
    topP: node.topP,
  });
  return {
    rewrite: pick(config.nodes.rewrite),
    intent: pick(config.nodes.intent),
    reply: pick(config.nodes.reply),
    fallback: pick(config.nodes.fallback),
  };
}

export async function runBackfill(
  db: DB,
): Promise<{ applications: number; versions: number; kbs: number }> {
  const appResult = await db.execute(sql`
    INSERT INTO applications
      (id, slug, name, description, enabled, production_config_version_id,
       created_by, updated_by, created_at, updated_at)
    SELECT id, id::text, name, "desc", enabled, current_version_id,
           updated_by, updated_by, created_at, updated_at
    FROM agents
    ON CONFLICT (id) DO NOTHING
  `);

  const legacyVersions = await db.execute(sql`SELECT * FROM agent_config_versions ORDER BY id`);
  let versions = 0;
  let kbs = 0;
  for (const raw of legacyVersions.rows as unknown as LegacyVersion[]) {
    const kbRows = await db.execute(
      sql`SELECT kb_id FROM agent_config_version_kbs WHERE version_id = ${raw.id} ORDER BY kb_id`,
    );
    const kbIds = kbRows.rows.map((item) => String((item as { kb_id: string }).kb_id));
    const config = mapVersion(raw, kbIds);
    await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(applicationConfigVersions)
        .values({
          id: raw.id,
          applicationId: raw.agent_id,
          version: raw.version,
          configSchemaVersion: 1,
          promptRewriteVersionId: config.nodes.rewrite.promptVersionId,
          promptIntentVersionId: config.nodes.intent.promptVersionId,
          promptReplyVersionId: config.nodes.reply.promptVersionId,
          promptFallbackVersionId: config.nodes.fallback.promptVersionId,
          rewriteModelId: config.nodes.rewrite.modelId,
          intentModelId: config.nodes.intent.modelId,
          replyModelId: config.nodes.reply.modelId,
          fallbackModelId: config.nodes.fallback.modelId,
          rerankModelId: config.retrieval.rerankModelId,
          nodeParams: persistedNodeParams(config),
          retrievalParams: config.retrieval,
          fallbackParams: config.fallback,
          note: raw.note,
          createdBy: raw.created_by,
          createdAt: raw.created_at instanceof Date ? raw.created_at : new Date(raw.created_at),
        })
        .onConflictDoNothing({ target: applicationConfigVersions.id })
        .returning({ id: applicationConfigVersions.id });
      versions += inserted.length;
      if (kbIds.length > 0) {
        const insertedKbs = await tx
          .insert(applicationConfigVersionKbs)
          .values(kbIds.map((kbId) => ({ configVersionId: raw.id, kbId })))
          .onConflictDoNothing()
          .returning({ kbId: applicationConfigVersionKbs.kbId });
        kbs += insertedKbs.length;
      }
    });
  }
  return { applications: appResult.rowCount ?? 0, versions, kbs };
}

export async function verifyBackfill(db: DB): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  const counts = await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM agents) old_apps,
      (SELECT count(*)::int FROM applications) new_apps,
      (SELECT count(*)::int FROM agent_config_versions) old_versions,
      (SELECT count(*)::int FROM application_config_versions) new_versions,
      (SELECT count(*)::int FROM agent_config_version_kbs) old_kbs,
      (SELECT count(*)::int FROM application_config_version_kbs) new_kbs
  `);
  const count = counts.rows[0] as Record<string, number>;
  for (const [oldKey, newKey] of [
    ["old_apps", "new_apps"],
    ["old_versions", "new_versions"],
    ["old_kbs", "new_kbs"],
  ] as const) {
    if (Number(count[oldKey]) !== Number(count[newKey])) {
      problems.push(`${oldKey}/${newKey} 行数不一致`);
    }
  }
  const badPointers = await db.execute(sql`
    SELECT count(*)::int n FROM applications a
    WHERE a.production_config_version_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM application_config_versions v
      WHERE v.id = a.production_config_version_id AND v.application_id = a.id
    )
  `);
  if (Number((badPointers.rows[0] as { n: number }).n) > 0) {
    problems.push("production 指针未指向所属应用配置版本");
  }

  const badApplications = await db.execute(sql`
    SELECT count(*)::int n FROM agents old
    JOIN applications target ON target.id = old.id
    WHERE target.slug <> old.id::text
       OR target.name <> old.name
       OR target.description <> old."desc"
       OR target.enabled IS DISTINCT FROM old.enabled
       OR target.created_by <> old.updated_by
       OR target.updated_by <> old.updated_by
       OR target.created_at IS DISTINCT FROM old.created_at
       OR target.updated_at IS DISTINCT FROM old.updated_at
       OR target.production_config_version_id IS DISTINCT FROM old.current_version_id
  `);
  if (Number((badApplications.rows[0] as { n: number }).n) > 0) {
    problems.push("applications 存在与 legacy identity 映射不一致的行");
  }

  const legacyVersionRows = await db.execute(sql`SELECT * FROM agent_config_versions ORDER BY id`);
  const legacyVersions = legacyVersionRows.rows as unknown as LegacyVersion[];
  const rows = await db.select().from(applicationConfigVersions);
  for (const row of rows) {
    const kbRows = await db
      .select({ kbId: applicationConfigVersionKbs.kbId })
      .from(applicationConfigVersionKbs)
      .where(eq(applicationConfigVersionKbs.configVersionId, row.id));
    const targetConfig = ApplicationConfigFieldsSchema.parse({
      kbIds: kbRows.map((item) => item.kbId),
      nodes: {
        rewrite: {
          ...row.nodeParams.rewrite,
          promptVersionId: row.promptRewriteVersionId,
          modelId: row.rewriteModelId,
        },
        intent: {
          ...row.nodeParams.intent,
          promptVersionId: row.promptIntentVersionId,
          modelId: row.intentModelId,
        },
        reply: {
          ...row.nodeParams.reply,
          promptVersionId: row.promptReplyVersionId,
          modelId: row.replyModelId,
        },
        fallback: {
          ...row.nodeParams.fallback,
          promptVersionId: row.promptFallbackVersionId,
          modelId: row.fallbackModelId,
        },
      },
      retrieval: row.retrievalParams,
      fallback: row.fallbackParams,
    });
    const source = legacyVersions.find((legacy) => legacy.id === row.id);
    if (!source) {
      problems.push(`配置版本 ${row.id} 没有对应 legacy 源行`);
      continue;
    }
    const sourceKbRows = await db.execute(
      sql`SELECT kb_id FROM agent_config_version_kbs WHERE version_id = ${source.id} ORDER BY kb_id`,
    );
    const expectedConfig = mapVersion(
      source,
      sourceKbRows.rows.map((item) => String((item as { kb_id: string }).kb_id)),
    );
    if (
      row.applicationId !== source.agent_id ||
      row.version !== source.version ||
      row.configSchemaVersion !== 1 ||
      row.rerankModelId !== source.rerank_model_id ||
      row.note !== source.note ||
      row.createdBy !== source.created_by ||
      row.createdAt.getTime() !== new Date(source.created_at).getTime() ||
      JSON.stringify(targetConfig) !== JSON.stringify(expectedConfig)
    ) {
      problems.push(`配置版本 ${row.id} 与 legacy 映射不一致`);
    }
  }
  return { ok: problems.length === 0, problems };
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);
  try {
    const result = await runBackfill(db);
    console.log("applications backfill", result);
    const verification = await verifyBackfill(db);
    if (!verification.ok) throw new Error(verification.problems.join("; "));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
