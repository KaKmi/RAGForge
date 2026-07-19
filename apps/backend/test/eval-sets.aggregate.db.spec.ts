import { readFileSync } from "fs";
import { join } from "path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { EvalSetsRepository } from "../src/modules/eval-runs/eval-sets.repository";
import { dbGate } from "./helpers/gated-suite";

/**
 * 屏2「上次得分」聚合的**真库**语义（`RUN_DB_TESTS=1` + `MIGRATION_TEST_DATABASE_URL` 才跑）。
 *
 * 为什么必须真库（同 018 §12 缺口 14 的理由）：这两列全是**相关子查询**，其正确性活在
 *  · 相关引用的解析（`SET_AGG_SELECT` 顶部注释记的坑：drizzle 把 `${evalSets.id}` 渲染成
 *    **未限定**的 `"id"`，会被内层表抢解析 → 必须显式写 `"eval_sets"."id"`）；
 *  · `AVG` 对 NULL 的忽略语义。
 * 两者 fake repo 都复刻不出来 —— 只有 PG 说了算。
 *
 * 钉死的不变式（QA P2 / 018 §12 缺口 16）：
 *  **① `lastRunScore=NULL` 有两种成因，`hasCompletedRun` 必须把它们分开；**
 *  **② 两列的 run population 必须逐字一致（`done|partial|budget_stop`，`failed` 不计）。**
 * 破了 ① 屏2 就会把「跑过 5 次但没出分」说成「未运行」（= 断言假事实）；
 * 破了 ② 就会造出「hasCompletedRun=true 但分数恒 NULL」的幻影态，让消歧位本身变成新的谎。
 */
const describeDb = dbGate();
const migrationsDir = join(__dirname, "..", "drizzle");

describeDb("EvalSetsRepository.listAggregates —— 上次得分的两列口径（真库）", () => {
  let pool: Pool;
  let repo: EvalSetsRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.MIGRATION_TEST_DATABASE_URL });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    const journal = JSON.parse(
      readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string }> };
    for (const { tag } of journal.entries) {
      const migration = readFileSync(join(migrationsDir, `${tag}.sql`), "utf8");
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await pool.query(statement);
      }
    }
    repo = new EvalSetsRepository(drizzle(pool) as never);
  });

  afterAll(async () => {
    await pool?.end();
  });

  /** 建一条指定状态的 run（字段取非空约束的最小集）。 */
  async function makeRun(setId: string, status: string): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO eval_runs (set_id, application_id, config_version_id, judge_model_id,
         embedding_model_id, offline_judge_version, status, scope, case_version_snapshot,
         total_cases, done_cases, token_budget, tokens_used, created_by)
       VALUES ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
         'offline-v1', $2, 'all', '[]'::jsonb, 1, 1, 100, 10, 'tester') RETURNING id`,
      [setId, status],
    );
    return rows[0].id as string;
  }

  /** 给 run 加一条结果行；`scores=null` 模拟「全部超时/裁判全挂」——四指标皆 NULL。 */
  async function makeResult(setId: string, runId: string, scores: number | null): Promise<void> {
    const { version } = await repo.insertCaseWithVersion({
      setId,
      // 真实字段是 goldDocRefs（gold_doc_refs jsonb）；此前写的 goldDocIds 是个**不存在的键**，
      // drizzle 会静默丢掉它、列走 DEFAULT '[]'::jsonb —— backend test/ 不做类型检查故一直没人发现。
      content: { question: "q", goldPoints: ["p"], goldDocRefs: [], tags: [] },
    });
    await pool.query(
      `INSERT INTO eval_run_results (run_id, case_version_id, seq, verdict, faithfulness,
         answer_relevancy, context_precision, correctness, evidence, answer, tokens_used, duration_ms)
       VALUES ($1, $2, 1, $3, $4, $4, $4, $4, '{}'::jsonb, 'a', 1, 1)`,
      [runId, version.id, scores === null ? "timeout" : "pass", scores],
    );
  }

  const newSet = (name: string) =>
    repo.insertSet({ name, description: "", kbIds: [], createdBy: "tester" });

  it("从未跑过 → hasCompletedRun=false + score NULL（这才配叫「未运行」）", async () => {
    const set = await newSet("从未跑过");
    const row = (await repo.listAggregates(set.id))[0];
    expect(row.hasCompletedRun).toBe(false);
    expect(row.lastRunScore).toBeNull();
  });

  // 本文件的**核心**用例：QA 实测的那 5 次 run 就落在这一态上。
  it("跑完但一个分都没评出来 → hasCompletedRun=true 而 score 仍 NULL（绝不退化成 0）", async () => {
    const set = await newSet("全超时的集");
    await makeResult(set.id, await makeRun(set.id, "done"), null);
    const row = (await repo.listAggregates(set.id))[0];
    expect(row.hasCompletedRun).toBe(true);
    expect(row.lastRunScore).toBeNull();
  });

  it("跑完且有分 → 两列一致（true + 实分）", async () => {
    const set = await newSet("正常出分的集");
    await makeResult(set.id, await makeRun(set.id, "done"), 90);
    const row = (await repo.listAggregates(set.id))[0];
    expect(row.hasCompletedRun).toBe(true);
    expect(row.lastRunScore).toBe(90);
  });

  it("只有 failed run → 两列都不认它（population 逐字一致，018 §12 缺口 12 的口径）", async () => {
    const set = await newSet("只有failed的集");
    await makeResult(set.id, await makeRun(set.id, "failed"), 90);
    const row = (await repo.listAggregates(set.id))[0];
    expect(row.hasCompletedRun).toBe(false);
    expect(row.lastRunScore).toBeNull();
  });

  it("partial / budget_stop 同样算「跑过」（三态 population 全覆盖）", async () => {
    for (const status of ["partial", "budget_stop"]) {
      const set = await newSet(`${status} 的集`);
      await makeResult(set.id, await makeRun(set.id, status), null);
      const row = (await repo.listAggregates(set.id))[0];
      expect(row.hasCompletedRun).toBe(true);
      expect(row.lastRunScore).toBeNull();
    }
  });

  it("多集并存时相关子查询不串行（显式限定 \"eval_sets\".\"id\" 的回归网）", async () => {
    const scored = await newSet("A 有分");
    const never = await newSet("B 没跑");
    await makeResult(scored.id, await makeRun(scored.id, "done"), 82);

    const rows = await repo.listAggregates();
    const find = (id: string) => rows.find((r) => r.id === id)!;
    // 若相关引用被内层表抢解析，两行会拿到同一个（错的）值
    expect(find(scored.id).hasCompletedRun).toBe(true);
    expect(find(scored.id).lastRunScore).toBe(82);
    expect(find(never.id).hasCompletedRun).toBe(false);
    expect(find(never.id).lastRunScore).toBeNull();
  });
});
