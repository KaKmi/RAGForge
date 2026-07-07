import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { extractVars } from "@codecrush/contracts";
import { users } from "../modules/users/schema";
import { hashPassword } from "../modules/users/password";
import { normalizeEmail } from "../modules/users/users.service";
import { prompts, promptVersions } from "../modules/prompts/schema";

const DEMO_EMAIL = normalizeEmail(process.env.DEMO_USER_EMAIL ?? "demo@codecrush.local");
const DEMO_PASSWORD = process.env.DEMO_USER_PASSWORD ?? "CodeCrushDemo123!";
const DEMO_DISPLAY_NAME = process.env.DEMO_USER_DISPLAY_NAME ?? "Demo Admin";

const SEED_AUTHOR = "system@codecrush.local";

// D9：4 默认 Prompt（rewrite/intent/reply/fallback 各 v1 prod），保 demo 连续性
// （M2 mock 有 4 个 prod 版本；seed 直接到 prod + currentVersionId，demo 无需手动发布）
const DEFAULT_PROMPTS = [
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
    body: "基于以下检索结果回答用户问题。问题：{query}\n上下文：{context}",
  },
  {
    name: "兜底回复-通用",
    node: "fallback",
    body: "抱歉，未找到相关信息，已转人工。",
  },
] as const;

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
      .values({
        name: dp.name,
        node: dp.node,
        currentVersionId: null,
        updatedBy: SEED_AUTHOR,
      })
      .onConflictDoNothing({ target: prompts.name })
      .returning();
    if (!prompt) continue; // 已存在则跳过，不重复 seed version
    const [version] = await db
      .insert(promptVersions)
      .values({
        promptId: prompt.id,
        version: 1,
        body: dp.body,
        variables: extractVars(dp.body),
        author: SEED_AUTHOR,
        status: "prod",
      })
      .returning();
    await db
      .update(prompts)
      .set({ currentVersionId: version.id, updatedBy: SEED_AUTHOR, updatedAt: new Date() })
      .where(eq(prompts.id, prompt.id));
  }

  await pool.end();
  console.log(`demo user ensured: ${DEMO_EMAIL}`);
  console.log(`default prompts ensured: ${DEFAULT_PROMPTS.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
