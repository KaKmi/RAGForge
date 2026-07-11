import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { documents } from "../documents/schema";
import { knowledgeBases } from "../knowledge-bases/schema";

// 处理 Profile 的可执行类型属于 ingestion 域；schema 只保存不可变 JSON 快照，
// 不引用 service/profile 实现，保持域内表定义纯净。
export const documentProcessingRuns = pgTable(
  "document_processing_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    kbId: uuid("kb_id")
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    targetVersion: integer("target_version").notNull(),
    profileId: text("profile_id").notNull(),
    profileVersion: integer("profile_version").notNull(),
    profileSnapshot: jsonb("profile_snapshot").notNull().$type<Record<string, unknown>>(),
    parserEngine: text("parser_engine"),
    parserVersion: text("parser_version"),
    canonicalBlobKey: text("canonical_blob_key"),
    status: text("status").notNull().default("queued"),
    warnings: jsonb("warnings").notNull().default([]).$type<string[]>(),
    metrics: jsonb("metrics").notNull().default({}).$type<Record<string, number>>(),
    error: text("error"),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("dpr_active_doc_unique")
      .on(table.documentId)
      .where(sql`status in ('queued', 'running')`),
    index("dpr_doc_created_idx").on(table.documentId, table.createdAt),
  ],
);

export type ProcessingRunRow = typeof documentProcessingRuns.$inferSelect;
export type NewProcessingRun = typeof documentProcessingRuns.$inferInsert;
