import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { compilePromptBody, extractVars, NODE_CONTRACT_VERSION } from "@codecrush/contracts";
import type { PromptNode } from "@codecrush/contracts";
import { users } from "../modules/users/schema";
import { hashPassword } from "../modules/users/password";
import { normalizeEmail } from "../modules/users/users.service";
import { prompts, promptVersions, promptVersionTags } from "../modules/prompts/schema";
import { modelProviders } from "../modules/models/schema";
import { knowledgeBases } from "../modules/knowledge-bases/schema";
import {
  applicationConfigVersionKbs,
  applicationConfigVersions,
  applications,
} from "../modules/applications/schema";

const DEMO_EMAIL = normalizeEmail(process.env.DEMO_USER_EMAIL ?? "demo@codecrush.local");
const DEMO_PASSWORD = process.env.DEMO_USER_PASSWORD ?? "CodeCrushDemo123!";
const DEMO_DISPLAY_NAME = process.env.DEMO_USER_DISPLAY_NAME ?? "Demo Admin";

const SEED_AUTHOR = "system@codecrush.local";

// D9：4 默认 Prompt（各 v1 + production 标签，保 demo 连续性）。
// 012：标签只是记账信号，不产生上线语义；body 字段对齐 NODE_CONTRACTS 权威字段表。
const DEFAULT_PROMPTS: ReadonlyArray<{ name: string; node: PromptNode; body: string }> = [
  {
    name: "问题改写-通用",
    node: "rewrite",
    body: "你是一个问题改写器，请将用户问题改写为更利于检索的形式。问题：{query}",
  },
  {
    name: "意图识别-通用",
    node: "intent",
    body: "请识别用户意图，输出意图标签。问题：{query}",
  },
  {
    name: "回复生成-通用",
    node: "reply",
    body: "基于以下检索结果回答用户问题。问题：{query}\n上下文：{retrievalContext}",
  },
  {
    name: "兜底回复-通用",
    node: "fallback",
    body: "抱歉，未找到相关信息，已转人工。",
  },
];

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  await db
    .insert(users)
    .values({ email: DEMO_EMAIL, displayName: DEMO_DISPLAY_NAME, passwordHash })
    .onConflictDoNothing({ target: users.email });

  for (const dp of DEFAULT_PROMPTS) {
    const [prompt] = await db
      .insert(prompts)
      .values({ name: dp.name, node: dp.node, updatedBy: SEED_AUTHOR })
      .onConflictDoNothing({ target: prompts.name })
      .returning();
    if (!prompt) continue; // 已存在则跳过，不重复 seed version
    const compiled = compilePromptBody(dp.body, dp.node);
    const [version] = await db
      .insert(promptVersions)
      .values({
        promptId: prompt.id,
        version: 1,
        body: dp.body,
        variables: extractVars(dp.body),
        contractVersion: NODE_CONTRACT_VERSION,
        compileStatus: compiled.status,
        compileErrors: compiled.issues,
        author: SEED_AUTHOR,
      })
      .returning();
    await db.insert(promptVersionTags).values({
      promptId: prompt.id,
      promptVersionId: version.id,
      name: "production",
      createdBy: SEED_AUTHOR,
    });
  }

  await seedDemoApplication(db);

  await pool.end();
  console.log(`demo user ensured: ${DEMO_EMAIL}`);
  console.log(`default prompts ensured: ${DEFAULT_PROMPTS.length}`);
}

const DEMO_APP_SLUG = "demo-aftersale";

// D6：条件演示应用。依赖已 seed 的 4 默认 Prompt v1 + 一个启用 llm 模型 + 一个知识库
//（seed 不建模型/知识库；缺任一则跳过并日志说明）。production 指针留空——新建 v1 不上线
//（002 验收 1），上线语义属 M7b。幂等：按 slug onConflictDoNothing。
async function seedDemoApplication(db: ReturnType<typeof drizzle>): Promise<void> {
  const [model] = await db
    .select({ id: modelProviders.id })
    .from(modelProviders)
    .where(and(eq(modelProviders.type, "llm"), eq(modelProviders.enabled, true)))
    .limit(1);
  if (!model) {
    console.log("no enabled llm model; skip demo application seed");
    return;
  }
  const [kb] = await db.select({ id: knowledgeBases.id }).from(knowledgeBases).limit(1);
  if (!kb) {
    console.log("no knowledge base; skip demo application seed");
    return;
  }
  const nodeVersionIds: Partial<Record<PromptNode, string>> = {};
  for (const dp of DEFAULT_PROMPTS) {
    const [pv] = await db
      .select({ id: promptVersions.id })
      .from(promptVersions)
      .innerJoin(prompts, eq(promptVersions.promptId, prompts.id))
      .where(and(eq(prompts.name, dp.name), eq(promptVersions.version, 1)))
      .limit(1);
    if (pv) nodeVersionIds[dp.node] = pv.id;
  }
  if (
    !nodeVersionIds.rewrite ||
    !nodeVersionIds.intent ||
    !nodeVersionIds.reply ||
    !nodeVersionIds.fallback
  ) {
    console.log("default prompt versions incomplete; skip demo application seed");
    return;
  }

  const [application] = await db
    .insert(applications)
    .values({
      slug: DEMO_APP_SLUG,
      name: "售后助手 Demo",
      description: "M7a 演示应用（未上线）",
      enabled: true,
      productionConfigVersionId: null,
      createdBy: SEED_AUTHOR,
      updatedBy: SEED_AUTHOR,
    })
    .onConflictDoNothing({ target: applications.slug })
    .returning();
  if (!application) {
    console.log(`demo application already exists: ${DEMO_APP_SLUG}`);
    return;
  }

  const nodeParam = { freedom: "balance" as const, temperature: 0.7, topP: 0.9 };
  const [version] = await db
    .insert(applicationConfigVersions)
    .values({
      applicationId: application.id,
      version: 1,
      configSchemaVersion: 1,
      promptRewriteVersionId: nodeVersionIds.rewrite,
      promptIntentVersionId: nodeVersionIds.intent,
      promptReplyVersionId: nodeVersionIds.reply,
      promptFallbackVersionId: nodeVersionIds.fallback,
      rewriteModelId: model.id,
      intentModelId: model.id,
      replyModelId: model.id,
      fallbackModelId: model.id,
      rerankModelId: null,
      nodeParams: {
        rewrite: nodeParam,
        intent: nodeParam,
        reply: nodeParam,
        fallback: nodeParam,
      },
      retrievalParams: {
        schemaVersion: 1,
        topK: 20,
        topN: 5,
        hybridEnabled: true,
        vectorWeight: 0.7,
        rerankEnabled: false,
      },
      fallbackParams: { toHuman: true },
      note: null,
      createdBy: SEED_AUTHOR,
    })
    .returning();
  await db
    .insert(applicationConfigVersionKbs)
    .values({ configVersionId: version.id, kbId: kb.id });
  console.log(`demo application ensured: ${DEMO_APP_SLUG}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
