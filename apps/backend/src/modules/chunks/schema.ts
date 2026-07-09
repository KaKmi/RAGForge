import { index, integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { vector1024 } from "../../platform/persistence/pgvector-type";
import { documents } from "../documents/schema";
import { knowledgeBases } from "../knowledge-bases/schema";

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
}
