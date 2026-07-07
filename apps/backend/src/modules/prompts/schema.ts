import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// 域内 schema：零 service 引用（003 不变量 5 / AGENTS.md 不变量 8），防循环 import。
// 001:88 已列 prompt_versions(...,variables jsonb,...,author,status) 表结构，对齐权威。

export const prompts = pgTable("prompts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  node: text("node").notNull(),
  // currentVersionId nullable：未发布任何版本时为 null（D 修订：min(1) → nullable）
  currentVersionId: uuid("current_version_id"),
  updatedBy: text("updated_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const promptVersions = pgTable(
  "prompt_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    promptId: uuid("prompt_id")
      .notNull()
      .references(() => prompts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    body: text("body").notNull(),
    // variables jsonb（001:88）；.$type<string[]> 仅 TS 层断言，运行时 jsonb
    variables: jsonb("variables").notNull().default([]).$type<string[]>(),
    note: text("note"),
    author: text("author").notNull(),
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    // D8：unique(promptId, version) 兜底并发撞号；index(promptId, status) 加速 prod 查询
    uniqPromptVersion: uniqueIndex("prompt_versions_prompt_id_version_idx").on(
      t.promptId,
      t.version,
    ),
    promptStatusIdx: index("prompt_versions_prompt_id_status_idx").on(t.promptId, t.status),
  }),
);

export type PromptRow = typeof prompts.$inferSelect;
export type NewPrompt = typeof prompts.$inferInsert;
export type PromptVersionRow = typeof promptVersions.$inferSelect;
export type NewPromptVersion = typeof promptVersions.$inferInsert;
