import { customType, index, integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { vector1024 } from "../../platform/persistence/pgvector-type";
import { documents } from "../documents/schema";
import { documentProcessingRuns } from "../ingestion/schema";
import { knowledgeBases } from "../knowledge-bases/schema";

// tsvector 列类型：drizzle-orm 无内置类型，仿 pgvector-type 的 customType 先例。
// 只做类型声明供查询构造（tsv @@ tsquery / ts_rank_cd）；真实 DDL 是 GENERATED ALWAYS AS
// (to_tsvector('simple', cjk_bigram_text(text))) STORED（手写迁移 0008，同 0006 HNSW 先例——
// drizzle-kit 推导不出生成列表达式与自定义 SQL 函数）。生成列只读，插入路径不写它。
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    docId: uuid("doc_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    kbId: uuid("kb_id")
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    seq: integer("seq").notNull(),
    text: text("text").notNull(),
    tokenCount: integer("token_count").notNull(),
    section: text("section").notNull().default(""),
    embedding: vector1024("embedding").notNull(),
    tsv: tsvector("tsv"),
    processingRunId: uuid("processing_run_id").references(() => documentProcessingRuns.id, {
      onDelete: "set null",
    }),
    contentType: text("content_type"),
    pageStart: integer("page_start"),
    pageEnd: integer("page_end"),
    assetKey: text("asset_key"),
  },
  (table) => [
    unique("chunks_doc_version_seq_unique").on(table.docId, table.version, table.seq),
    index("chunks_kb_version_idx").on(table.kbId, table.version),
  ],
);
export type ChunkRow = typeof chunks.$inferSelect;
export type NewChunk = typeof chunks.$inferInsert;

// 组装态（无 id，来自管线尚未落库的产物），供 ingestion pipeline 与 repository.replaceVersion 之间传递
export interface ChunkDraft {
  seq: number;
  text: string;
  tokenCount: number;
  section: string;
  embedding: number[];
  processingRunId?: string | null;
  contentType?: string | null;
  pageStart?: number | null;
  pageEnd?: number | null;
  assetKey?: string | null;
}
