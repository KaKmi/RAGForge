import type { ApplicationNodeConfig, ApplicationRetrievalParams } from "@codecrush/contracts";
import {
  boolean,
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

export type ApplicationRow = typeof applications.$inferSelect;
export type NewApplication = typeof applications.$inferInsert;
export type ApplicationConfigVersionRow = typeof applicationConfigVersions.$inferSelect;
export type NewApplicationConfigVersion = typeof applicationConfigVersions.$inferInsert;
