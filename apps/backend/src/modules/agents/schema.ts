import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { NodeParams } from "@codecrush/contracts";
import { modelProviders } from "../models/schema";
import { promptVersions } from "../prompts/schema";
import { knowledgeBases } from "../knowledge-bases/schema";

// 域内 schema：零 service 引用（003 不变量 5 / AGENTS.md 不变量 8）。
// 008:数据模型 — agents(身份+生产指针) / agent_config_versions(版本快照) /
// agent_config_version_kbs(版本级知识库快照)。

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  desc: text("desc").notNull().default(""),
  enabled: boolean("enabled").notNull().default(true),
  // 循环 FK：无 DB 层即时约束，靠 service 写入顺序保证（先插 agents(null) → 插 v1 → 回填），
  // 复刻 prompts.currentVersionId 既有写法（prompts/schema.ts:11）。
  currentVersionId: uuid("current_version_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  updatedBy: text("updated_by").notNull(),
});

export const agentConfigVersions = pgTable(
  "agent_config_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: text("status").notNull().default("draft"),
    genModelId: uuid("gen_model_id")
      .notNull()
      .references(() => modelProviders.id, { onDelete: "restrict" }),
    lightModelId: uuid("light_model_id").references(() => modelProviders.id, {
      onDelete: "restrict",
    }),
    rerankModelId: uuid("rerank_model_id").references(() => modelProviders.id, {
      onDelete: "restrict",
    }),
    promptRewriteVerId: uuid("prompt_rewrite_ver_id")
      .notNull()
      .references(() => promptVersions.id, { onDelete: "restrict" }),
    promptIntentVerId: uuid("prompt_intent_ver_id")
      .notNull()
      .references(() => promptVersions.id, { onDelete: "restrict" }),
    promptReplyVerId: uuid("prompt_reply_ver_id")
      .notNull()
      .references(() => promptVersions.id, { onDelete: "restrict" }),
    promptFallbackVerId: uuid("prompt_fallback_ver_id")
      .notNull()
      .references(() => promptVersions.id, { onDelete: "restrict" }),
    // .$type<T>() 仅 TS 层断言，运行时 jsonb（对齐 prompts/schema.ts:27 variables 的既有惯例）
    nodeParams: jsonb("node_params").notNull().default({}).$type<NodeParams>(),
    topK: integer("top_k").notNull(),
    topN: integer("top_n").notNull(),
    threshold: real("threshold").notNull(),
    multiRecall: boolean("multi_recall").notNull().default(true),
    vecWeight: real("vec_weight"),
    fallbackHuman: boolean("fallback_human").notNull().default(true),
    // M7 阶段：eval_status 只取 not_run/passed/exempt；evalPassRate 恒 null（stub 不编造数字，008 Trade-offs）
    evalStatus: text("eval_status").notNull().default("not_run"),
    evalRunAt: timestamp("eval_run_at"),
    evalPassRate: real("eval_pass_rate"),
    evalSummary: jsonb("eval_summary"),
    note: text("note"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    publishedBy: text("published_by"),
    publishedAt: timestamp("published_at"),
  },
  (t) => ({
    // 撞号兜底（同 prompts）；(agentId,status) 加速找当前 prod/可回滚 archived；
    // (agentId,createdAt) 供配置版本抽屉时间倒序
    uniqAgentVersion: uniqueIndex("agent_config_versions_agent_id_version_idx").on(
      t.agentId,
      t.version,
    ),
    agentStatusIdx: index("agent_config_versions_agent_id_status_idx").on(t.agentId, t.status),
    agentCreatedIdx: index("agent_config_versions_agent_id_created_at_idx").on(
      t.agentId,
      t.createdAt,
    ),
  }),
);

export const agentConfigVersionKbs = pgTable(
  "agent_config_version_kbs",
  {
    versionId: uuid("version_id")
      .notNull()
      .references(() => agentConfigVersions.id, { onDelete: "cascade" }),
    kbId: uuid("kb_id")
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "restrict" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.versionId, t.kbId] }),
    kbIdx: index("agent_config_version_kbs_kb_id_idx").on(t.kbId),
  }),
);

export type AgentRow = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type AgentConfigVersionRow = typeof agentConfigVersions.$inferSelect;
export type NewAgentConfigVersion = typeof agentConfigVersions.$inferInsert;
export type AgentConfigVersionKbRow = typeof agentConfigVersionKbs.$inferSelect;
