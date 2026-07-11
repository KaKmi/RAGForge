import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { modelProviders } from "../models/schema";

// 域内 schema：零 service 引用（003 不变量 8）。对齐 007 Design「存储 schema」。
// chunkTemplate 落 text，契约层收口合法值（同 model_providers.type/protocol 的处理方式）。
export const knowledgeBases = pgTable("knowledge_bases", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  desc: text("desc").notNull().default(""),
  chunkTemplate: text("chunk_template").notNull(), // "general" | "qa"
  defaultProfileId: text("default_profile_id"),
  defaultProfileVersion: integer("default_profile_version"),
  // 007 Design「存储 schema」：embedding_model_id → model_providers。RESTRICT（非 CASCADE/SET NULL）：
  // 创建后 embeddingModelId 锁定不可更换（service 层已拒绝 PATCH 携带该字段），所以模型被绑定期间
  // 语义上就不该能被删——RESTRICT 让 DB 兜底强制这条不变量，而不是只靠应用层校验。
  embeddingModelId: uuid("embedding_model_id")
    .notNull()
    .references(() => modelProviders.id, { onDelete: "restrict" }),
  status: text("status").notNull().default("ready"), // "ready" | "building" | "failed"
  activeVersion: integer("active_version").notNull().default(1),
  buildingVersion: integer("building_version"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type KnowledgeBaseRow = typeof knowledgeBases.$inferSelect;
export type NewKnowledgeBase = typeof knowledgeBases.$inferInsert;
