import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export interface OtelSpanFixture {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  at: string;
  name: string;
  attributes: Record<string, string>;
}

export const E2E_JUDGE_MODEL_ID = "11111111-1111-4111-8111-111111111111";
export const E2E_EMBED_MODEL_ID = "22222222-2222-4222-8222-222222222222";

export interface EvaluationInfraHarness {
  pool: Pool;
  db: ReturnType<typeof drizzle>;
  clickhouse: ClickHouseClient;
  resetAndMigrate(): Promise<void>;
  seedPgInput(traceId: string): Promise<{ chunkId: string }>;
  insertSpan(row: OtelSpanFixture): Promise<void>;
  cleanup(traceIds: string[]): Promise<void>;
  close(): Promise<void>;
}

export async function createEvaluationInfraHarness(): Promise<EvaluationInfraHarness> {
  const pool = new Pool({ connectionString: process.env.MIGRATION_TEST_DATABASE_URL });
  const db = drizzle(pool);
  const clickhouse = createClient({
    url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
  });
  return {
    pool,
    db,
    clickhouse,
    async resetAndMigrate() {
      await pool.query("DROP SCHEMA public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
      const dir = join(__dirname, "..", "..", "drizzle");
      const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as {
        entries: Array<{ tag: string }>;
      };
      for (const { tag } of journal.entries) {
        const sql = readFileSync(join(dir, `${tag}.sql`), "utf8");
        for (const statement of sql.split("--> statement-breakpoint")) {
          if (statement.trim()) await pool.query(statement.trim());
        }
      }
    },
    async seedPgInput(traceId) {
      await pool.query(
        `INSERT INTO model_providers
          (id,type,protocol,name,base_url,api_key_enc,params,enabled) VALUES
          ($1,'llm','openai_compat','e2e-judge','http://unused','enc','{}',true),
          ($2,'embedding','openai_compat','e2e-embed','http://unused','enc','{}',true)
          ON CONFLICT (id) DO NOTHING`,
        [E2E_JUDGE_MODEL_ID, E2E_EMBED_MODEL_ID],
      );
      const kb = await pool.query<{ id: string }>(
        `INSERT INTO knowledge_bases
          (name,"desc",chunk_template,embedding_model_id,status,active_version)
          VALUES ($1,'','general',$2,'ready',1) RETURNING id`,
        [`e2e-${traceId}`, E2E_EMBED_MODEL_ID],
      );
      const doc = await pool.query<{ id: string }>(
        `INSERT INTO documents (kb_id,name,type,size,blob_key,status,chunk_version)
          VALUES ($1,'policy','text',10,'e2e','ready',1) RETURNING id`,
        [kb.rows[0].id],
      );
      const chunk = await pool.query<{ id: string }>(
        `INSERT INTO chunks
          (doc_id,kb_id,version,seq,text,token_count,section,embedding)
          VALUES ($1,$2,1,0,'七天内可以退款',8,'policy',$3) RETURNING id`,
        [doc.rows[0].id, kb.rows[0].id, `[${Array(1024).fill(0).join(",")}]`],
      );
      const conversation = await pool.query<{ id: string }>(
        "INSERT INTO conversations(agent_id,title) VALUES ('agent-e2e','refund') RETURNING id",
      );
      await pool.query(
        `INSERT INTO messages(conv_id,role,content,trace_id) VALUES
          ($1,'user','退款期限多久',NULL),($1,'assistant','七天内可以退款',$2)`,
        [conversation.rows[0].id, traceId],
      );
      return { chunkId: chunk.rows[0].id };
    },
    async insertSpan(row) {
      await clickhouse.insert({
        table: "otel_traces",
        format: "JSONEachRow",
        values: [
          {
            Timestamp: row.at.replace("T", " ").replace("Z", "000000"),
            TraceId: row.traceId,
            SpanId: row.spanId,
            ParentSpanId: row.parentSpanId ?? "",
            TraceState: "",
            SpanName: row.name,
            SpanKind: "SPAN_KIND_INTERNAL",
            ServiceName: "codecrush-backend",
            ResourceAttributes: {},
            ScopeName: "e2e",
            ScopeVersion: "1",
            SpanAttributes: row.attributes,
            Duration: 0,
            StatusCode: "STATUS_CODE_OK",
            StatusMessage: "",
            Events: [],
            Links: [],
          },
        ],
        clickhouse_settings: { input_format_defaults_for_omitted_fields: 1 },
      });
    },
    async cleanup(traceIds) {
      await clickhouse.command({
        query:
          "ALTER TABLE otel_traces DELETE WHERE has({ids:Array(String)}, TraceId) OR has({ids:Array(String)}, SpanAttributes['rag.eval.target_trace_id'])",
        query_params: { ids: traceIds },
        clickhouse_settings: { mutations_sync: 2 },
      });
      await clickhouse.command({
        query:
          "ALTER TABLE codecrush_eval_targets DELETE WHERE has({ids:Array(String)}, target_trace_id)",
        query_params: { ids: traceIds },
        clickhouse_settings: { mutations_sync: 2 },
      });
      await pool.query(
        `UPDATE online_eval_settings SET enabled=false,sample_rate=0.1,
          judge_model_id=NULL,embedding_model_id=NULL,faithfulness_threshold=85,
          answer_relevancy_threshold=80,context_precision_threshold=80,daily_cap=500
          WHERE id='default'`,
      );
      await pool.query("DELETE FROM eval_watermarks WHERE worker_name='online-quality-v1'");
      await pool.query("DELETE FROM messages");
      await pool.query("DELETE FROM conversations WHERE agent_id='agent-e2e'");
      await pool.query("DELETE FROM chunks WHERE section='policy'");
      await pool.query("DELETE FROM documents WHERE blob_key='e2e'");
      await pool.query("DELETE FROM knowledge_bases WHERE name LIKE 'e2e-%'");
      await pool.query("DELETE FROM model_providers WHERE name IN ('e2e-judge','e2e-embed')");
    },
    async close() {
      await clickhouse.close();
      await pool.end();
    },
  };
}
