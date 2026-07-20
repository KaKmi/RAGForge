import { readFileSync } from "fs";
import { join } from "path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { EvalRunsRepository } from "../src/modules/eval-runs/eval-runs.repository";
import { dbGate } from "./helpers/gated-suite";

/**
 * B2b 屏3「标记忽略」的 **caseId → caseVersionId 桥接**（真库，`RUN_DB_TESTS=1` 才跑）。
 *
 * 为什么非真库不可：`eval_run_results` 表**没有 `case_id` 列**，只有 `case_version_id`；
 * 而 HTTP 路由参数是 **case id**。二者是不同的 UUID。写成
 * `eq(evalRunResults.caseVersionId, caseId)` 的话 WHERE **静默命中 0 行**——
 * 接口照样回 204、前端照样弹「已标记忽略」，而库里什么都没变。
 *
 * 这个坑用内存 fake 或前端测试**抓不住**：那些测试里 caseId 与 caseVersionId 都是
 * `"case-1"` 之类自造字符串，两种写法都「能匹配」。只有真库里两个真实 UUID 才分得开。
 * 交付时是靠人工跑 SELECT 验的——那不可持续，本 spec 就是把它钉死。
 *
 * 钉死两条：
 *  ① **逐 case 粒度**：该 case 在本 run 内的**全部** `repeat_index` 行一起被标；
 *  ② **不越界**：同一个 case 的另一个 run 的结果行**不受影响**——子查询按 caseId 找版本 id
 *    时会捞到该 case 的**所有**版本，全靠外层 `run_id` 谓词收口。少了它就会跨 run 误伤。
 *
 * ⛔ 只连 MIGRATION_TEST_DATABASE_URL（codecrush_mig_test）——本文件会 DROP SCHEMA。
 * 开发库 codecrush 里是用户手工搭建、无备份的数据，打到那上面就是永久丢失。
 */
const describeDb = dbGate();
const migrationsDir = join(__dirname, "..", "drizzle");

describeDb("EvalRunsRepository.setResultIgnored —— caseId→caseVersionId 桥接（真库）", () => {
  let pool: Pool;
  let repo: EvalRunsRepository;

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
    repo = new EvalRunsRepository(drizzle(pool) as never);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function makeSet(name: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO eval_sets (name, description, kb_ids, created_by)
       VALUES ($1, '', '{}', 'tester') RETURNING id`,
      [name],
    );
    return rows[0].id;
  }

  async function makeCase(setId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO eval_cases (set_id) VALUES ($1) RETURNING id`,
      [setId],
    );
    return rows[0].id;
  }

  /** 建一个用例版本。同一个 case 可以有多版——桥接必须靠外层 run_id 收口，见文件头注释②。 */
  async function makeCaseVersion(caseId: string, version: number): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO eval_case_versions (case_id, version, question, gold_points, gold_doc_refs, tags)
       VALUES ($1, $2, '课程可以退款吗', '{}', '[]'::jsonb, '{}') RETURNING id`,
      [caseId, version],
    );
    return rows[0].id;
  }

  async function makeRun(setId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO eval_runs (set_id, application_id, config_version_id, judge_model_id,
         embedding_model_id, offline_judge_version, status, scope, case_version_snapshot,
         total_cases, done_cases, token_budget, tokens_used, created_by)
       VALUES ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
         'offline-v1', 'done', 'all', '[]'::jsonb, 1, 1, 100, 10, 'tester') RETURNING id`,
      [setId],
    );
    return rows[0].id;
  }

  async function makeResult(
    runId: string,
    caseVersionId: string,
    repeatIndex: number,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO eval_run_results (run_id, case_version_id, seq, repeat_index, verdict)
       VALUES ($1, $2, 1, $3, 'low')`,
      [runId, caseVersionId, repeatIndex],
    );
  }

  async function ignoredCount(runId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM eval_run_results
       WHERE run_id = $1 AND ignored_at IS NOT NULL`,
      [runId],
    );
    return Number(rows[0].n);
  }

  it("按 caseId 标记 → 该 case 在本 run 内的全部 repeat 行都被标（逐 case 粒度）", async () => {
    const setId = await makeSet("忽略-粒度");
    const caseId = await makeCase(setId);
    const versionId = await makeCaseVersion(caseId, 1);
    const runId = await makeRun(setId);
    // repeatCount=3 的 run：同一个 case 有三行结果，忽略必须一起生效。
    await makeResult(runId, versionId, 1);
    await makeResult(runId, versionId, 2);
    await makeResult(runId, versionId, 3);

    await repo.setResultIgnored(runId, caseId, true, new Date());

    expect(await ignoredCount(runId)).toBe(3);
  });

  it("传的是 caseId 而不是 caseVersionId —— 两者不同，写错就 0 行且静默成功", async () => {
    const setId = await makeSet("忽略-桥接");
    const caseId = await makeCase(setId);
    const versionId = await makeCaseVersion(caseId, 1);
    const runId = await makeRun(setId);
    await makeResult(runId, versionId, 1);

    // 这条断言是本文件存在的理由：两个 id 必须真的不同，否则下面的验证没有区分力。
    expect(caseId).not.toBe(versionId);

    await repo.setResultIgnored(runId, caseId, true, new Date());
    expect(await ignoredCount(runId)).toBe(1);

    // 反向：拿 caseVersionId 当 caseId 传（正是「简化」成 eq(caseVersionId, caseId) 后
    // 会被误当成正确的那种调用），应当**一行都不匹配**。
    const other = await makeRun(setId);
    await makeResult(other, versionId, 1);
    await repo.setResultIgnored(other, versionId, true, new Date());
    expect(await ignoredCount(other)).toBe(0);
  });

  it("不跨 run 误伤：同一个 case 在另一个 run 的结果行不受影响", async () => {
    const setId = await makeSet("忽略-不跨run");
    const caseId = await makeCase(setId);
    // 同一个 case 的两个版本，分别被两个 run 引用——子查询按 caseId 会同时捞到这两个版本 id，
    // 全靠外层 run_id 谓词把范围收住。少了它，标 runA 会连 runB 一起标。
    const v1 = await makeCaseVersion(caseId, 1);
    const v2 = await makeCaseVersion(caseId, 2);
    const runA = await makeRun(setId);
    const runB = await makeRun(setId);
    await makeResult(runA, v1, 1);
    await makeResult(runB, v2, 1);

    await repo.setResultIgnored(runA, caseId, true, new Date());

    expect(await ignoredCount(runA)).toBe(1);
    expect(await ignoredCount(runB)).toBe(0);
  });

  it("ignored=false 把标志清回 NULL（可撤销），且同样是逐 case 粒度", async () => {
    const setId = await makeSet("忽略-可撤销");
    const caseId = await makeCase(setId);
    const versionId = await makeCaseVersion(caseId, 1);
    const runId = await makeRun(setId);
    await makeResult(runId, versionId, 1);
    await makeResult(runId, versionId, 2);

    await repo.setResultIgnored(runId, caseId, true, new Date());
    expect(await ignoredCount(runId)).toBe(2);

    await repo.setResultIgnored(runId, caseId, false, new Date());
    expect(await ignoredCount(runId)).toBe(0);
  });

  it("忽略**不动**分数与判定——它只是叠加标志（记分卡口径不受影响的地基）", async () => {
    const setId = await makeSet("忽略-不改分");
    const caseId = await makeCase(setId);
    const versionId = await makeCaseVersion(caseId, 1);
    const runId = await makeRun(setId);
    await pool.query(
      `INSERT INTO eval_run_results (run_id, case_version_id, seq, repeat_index, verdict,
         faithfulness, answer_relevancy, context_precision, min_metric, min_score)
       VALUES ($1, $2, 1, 1, 'low', 41, 79, 38, 'contextPrecision', 38)`,
      [runId, versionId],
    );

    await repo.setResultIgnored(runId, caseId, true, new Date());

    const { rows } = await pool.query<{
      verdict: string;
      faithfulness: number;
      min_score: number;
      ignored_at: Date | null;
    }>(
      `SELECT verdict, faithfulness, min_score, ignored_at FROM eval_run_results WHERE run_id = $1`,
      [runId],
    );
    expect(rows[0].ignored_at).not.toBeNull();
    expect(rows[0].verdict).toBe("low");
    expect(rows[0].faithfulness).toBe(41);
    expect(rows[0].min_score).toBe(38);
  });
});
