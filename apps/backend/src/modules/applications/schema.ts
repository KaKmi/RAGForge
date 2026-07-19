import { sql } from "drizzle-orm";
import type {
  ApplicationNodeConfig,
  ApplicationRetrievalParams,
  ReleaseCheckIssue,
} from "@codecrush/contracts";
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { knowledgeBases } from "../knowledge-bases/schema";
import { modelProviders } from "../models/schema";
import { promptVersions } from "../prompts/schema";

export const applications = pgTable("applications", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  enabled: boolean("enabled").notNull().default(true),
  /** B1/F5：上线门禁开关。默认 false（原型 §8「默认关(仅提示)」）。 */
  evalGateEnabled: boolean("eval_gate_enabled").notNull().default(false),
  // Circular ownership is validated transactionally by the applications service.
  productionConfigVersionId: uuid("production_config_version_id"),
  deletedAt: timestamp("deleted_at"),
  createdBy: text("created_by").notNull(),
  updatedBy: text("updated_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

type PersistedNodeParams = Record<
  "rewrite" | "intent" | "reply" | "fallback",
  Pick<ApplicationNodeConfig, "freedom" | "temperature" | "topP">
>;

export const applicationConfigVersions = pgTable(
  "application_config_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    configSchemaVersion: integer("config_schema_version").notNull().default(1),
    promptRewriteVersionId: uuid("prompt_rewrite_version_id")
      .notNull()
      .references(() => promptVersions.id, { onDelete: "restrict" }),
    promptIntentVersionId: uuid("prompt_intent_version_id")
      .notNull()
      .references(() => promptVersions.id, { onDelete: "restrict" }),
    promptReplyVersionId: uuid("prompt_reply_version_id")
      .notNull()
      .references(() => promptVersions.id, { onDelete: "restrict" }),
    promptFallbackVersionId: uuid("prompt_fallback_version_id")
      .notNull()
      .references(() => promptVersions.id, { onDelete: "restrict" }),
    rewriteModelId: uuid("rewrite_model_id")
      .notNull()
      .references(() => modelProviders.id, { onDelete: "restrict" }),
    intentModelId: uuid("intent_model_id")
      .notNull()
      .references(() => modelProviders.id, { onDelete: "restrict" }),
    replyModelId: uuid("reply_model_id")
      .notNull()
      .references(() => modelProviders.id, { onDelete: "restrict" }),
    fallbackModelId: uuid("fallback_model_id")
      .notNull()
      .references(() => modelProviders.id, { onDelete: "restrict" }),
    rerankModelId: uuid("rerank_model_id").references(() => modelProviders.id, {
      onDelete: "restrict",
    }),
    nodeParams: jsonb("node_params").notNull().$type<PersistedNodeParams>(),
    retrievalParams: jsonb("retrieval_params").notNull().$type<ApplicationRetrievalParams>(),
    fallbackParams: jsonb("fallback_params").notNull().$type<{ toHuman: boolean }>(),
    note: text("note"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    applicationVersionUnique: uniqueIndex(
      "application_config_versions_application_id_version_idx",
    ).on(table.applicationId, table.version),
    // M7b：供 application_config_version_tags 复合 FK 引用（标签行的版本必属同一应用，DB 级排他）
    idApplicationUnique: uniqueIndex("application_config_versions_id_application_id_uniq").on(
      table.id,
      table.applicationId,
    ),
    applicationCreatedAtIndex: index(
      "application_config_versions_application_id_created_at_idx",
    ).on(table.applicationId, table.createdAt.desc()),
  }),
);

export const applicationConfigVersionKbs = pgTable(
  "application_config_version_kbs",
  {
    configVersionId: uuid("config_version_id")
      .notNull()
      .references(() => applicationConfigVersions.id, { onDelete: "cascade" }),
    kbId: uuid("kb_id")
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "restrict" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.configVersionId, table.kbId] }),
    kbIndex: index("application_config_version_kbs_kb_id_idx").on(table.kbId),
  }),
);

// M7b 自定义命名标签（照抄 012 prompt_version_tags 范式：冗余 owner 列 + lower(name) 排他 + 复合 FK 归属）。
// production 是保留字，**不入本表**——上线走 applications.production_config_version_id 指针的受门禁 CAS。
export const applicationConfigVersionTags = pgTable(
  "application_config_version_tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    configVersionId: uuid("config_version_id").notNull(),
    name: text("name").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    // 排他性落点：应用内 lower(name) 唯一（大小写不敏感），服务边界同时归一小写
    uniqName: uniqueIndex("acvt_application_id_lower_name_idx").on(
      t.applicationId,
      sql`lower(${t.name})`,
    ),
    // 复合 FK：标签指向的版本必属同一应用（跨应用标签在 DB 层直接 23503 拒绝）；硬删版本时级联
    versionOwnershipFk: foreignKey({
      columns: [t.configVersionId, t.applicationId],
      foreignColumns: [applicationConfigVersions.id, applicationConfigVersions.applicationId],
      name: "acvt_version_owner_fk",
    }).onDelete("cascade"),
    versionIdx: index("acvt_config_version_id_idx").on(t.configVersionId),
  }),
);

// M7b ReleaseCheck：异步真实 NodeRuntime 预演的短期 artifact（不存完整模型 IO，只存摘要+trace）
export const applicationReleaseChecks = pgTable(
  "application_release_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    configVersionId: uuid("config_version_id")
      .notNull()
      .references(() => applicationConfigVersions.id, { onDelete: "cascade" }),
    configFingerprint: text("config_fingerprint").notNull(),
    status: text("status").notNull().$type<"queued" | "running" | "passed" | "failed" | "expired">(),
    issues: jsonb("issues").notNull().default([]).$type<ReleaseCheckIssue[]>(),
    sampleSummary: jsonb("sample_summary").notNull().default({}).$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    expiresAt: timestamp("expires_at"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    appVersionIndex: index("arc_app_ver_created_idx").on(
      t.applicationId,
      t.configVersionId,
      t.createdAt.desc(),
    ),
    statusIndex: index("arc_status_created_idx").on(t.status, t.createdAt),
  }),
);

export type ApplicationRow = typeof applications.$inferSelect;
export type NewApplication = typeof applications.$inferInsert;
export type ApplicationConfigVersionRow = typeof applicationConfigVersions.$inferSelect;
export type NewApplicationConfigVersion = typeof applicationConfigVersions.$inferInsert;
export type ApplicationConfigVersionTagRow = typeof applicationConfigVersionTags.$inferSelect;
export type NewApplicationConfigVersionTag = typeof applicationConfigVersionTags.$inferInsert;
export type ReleaseCheckRow = typeof applicationReleaseChecks.$inferSelect;
export type NewReleaseCheck = typeof applicationReleaseChecks.$inferInsert;
