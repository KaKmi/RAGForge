import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { knowledgeBases } from "../knowledge-bases/schema";

export interface LifecycleStageRow {
  stage: "upload" | "ingest" | "ready";
  status: "pending" | "running" | "done" | "failed";
  startedAt: string | null;
  endedAt: string | null;
  error?: string | null;
}

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  kbId: uuid("kb_id")
    .notNull()
    .references(() => knowledgeBases.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type").notNull(), // "pdf" | "word" | "markdown" | "text"
  size: integer("size").notNull(),
  blobKey: text("blob_key").notNull(),
  parsedText: text("parsed_text"),
  metadata: jsonb("metadata").notNull().default({}).$type<Record<string, string>>(),
  status: text("status").notNull().default("pending"), // pending|queued|processing|failed|ready
  chunkVersion: integer("chunk_version"),
  profileOverrideId: text("profile_override_id"),
  profileOverrideVersion: integer("profile_override_version"),
  lifecycle: jsonb("lifecycle").notNull().default([]).$type<LifecycleStageRow[]>(),
  error: text("error"),
  uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type DocumentRow = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
