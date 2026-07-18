import { readFileSync } from "fs";
import { join } from "path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { ConversationsRepository } from "../src/modules/conversations/conversations.repository";
import { dbGate } from "./helpers/gated-suite";

const describeDb = dbGate();
const migrationsDir = join(__dirname, "..", "drizzle");
jest.setTimeout(180_000);

async function resetAndMigrate(pool: Pool): Promise<void> {
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  const journal = JSON.parse(
    readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };
  for (const { tag } of journal.entries) {
    const sql = readFileSync(join(migrationsDir, `${tag}.sql`), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) await pool.query(statement.trim());
    }
  }
}

describeDb("conversation evaluation turn lookup", () => {
  let pool: Pool;
  let repo: ConversationsRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.MIGRATION_TEST_DATABASE_URL });
    await resetAndMigrate(pool);
    repo = new ConversationsRepository(drizzle(pool) as never);
  });
  afterAll(async () => await pool.end());

  async function conversation(agentId: string): Promise<string> {
    return (
      await pool.query(
        "INSERT INTO conversations(agent_id,title) VALUES ($1,'eval') RETURNING id",
        [agentId],
      )
    ).rows[0].id as string;
  }

  async function message(
    convId: string,
    role: string,
    content: string,
    traceId?: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO messages(conv_id,role,content,trace_id,created_at)
       VALUES ($1,$2,$3,$4,'2026-07-15T01:00:00Z')`,
      [convId, role, content, traceId ?? null],
    );
  }

  it("uses the immediately preceding sequence row despite equal timestamps", async () => {
    const a = await conversation("agent-a");
    const b = await conversation("agent-b");
    await message(b, "user", "other conversation");
    await message(a, "user", "question one");
    await message(a, "assistant", "answer one", "1".repeat(32));
    await message(a, "user", "question two");
    await message(a, "assistant", "answer two", "2".repeat(32));

    await expect(repo.findEvaluationTurnByTraceId("1".repeat(32))).resolves.toEqual({
      agentId: "agent-a",
      question: "question one",
      answer: "answer one",
    });
    await expect(repo.findEvaluationTurnByTraceId("2".repeat(32))).resolves.toEqual({
      agentId: "agent-a",
      question: "question two",
      answer: "answer two",
    });
  });

  it("does not jump over an intervening assistant", async () => {
    const convId = await conversation("agent-c");
    await message(convId, "user", "old question");
    await message(convId, "assistant", "intervening answer");
    await message(convId, "assistant", "target answer", "3".repeat(32));
    await expect(repo.findEvaluationTurnByTraceId("3".repeat(32))).resolves.toBeUndefined();
  });
});
