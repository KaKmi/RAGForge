import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const appMeta = pgTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export * from "../modules/users/schema";
export * from "../modules/prompts/schema";
export * from "../modules/models/schema";
export * from "../modules/knowledge-bases/schema";
export * from "../modules/documents/schema";
export * from "../modules/chunks/schema";
export * from "../modules/agents/schema";
