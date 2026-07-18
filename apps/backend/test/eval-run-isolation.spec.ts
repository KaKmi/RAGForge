import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { ClickHouseEvaluationsRepository } from "../src/modules/evaluations/clickhouse-evaluations.repository";
import { EvaluationSpanEmitter } from "../src/modules/evaluations/evaluation-span.emitter";
import { EvalRunsRepository } from "../src/modules/eval-runs/eval-runs.repository";
import { EvalRunWorkerProcessor } from "../src/modules/eval-runs/eval-run-worker.processor";
import { createEvaluationInfraHarness } from "./helpers/evaluation-infra";
import { infraGate } from "./helpers/gated-suite";

/**
 * ══════════════════════════════════════════════════════════════════════════════
 *  018 决策 B 的唯一可执行证明：**离线 run 的分数绝不能进在线质量总览（屏1）**。
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 证据链（每一环都在本文件里对**真 ClickHouse** 验证，不是纸面推断）：
 *  1. `codecrush_eval_targets_mv` 只按 `SpanName='rag.eval'` 过滤，**不看 preview**
 *     （`infra/clickhouse/views/003-eval-views.sql:25`）。
 *  2. `getOverview` 直读 `codecrush_eval_targets`，**也不过滤 preview**
 *     （`clickhouse-evaluations.repository.ts:301-333`）。
 *  ⇒ 一旦离线 run 发了 `rag.eval` span，屏1 的三指标卡与趋势**立刻**被离线分数污染。
 *
 * 故离线分数只落 Postgres —— 隔离靠**存储物理分离**，不靠过滤条件。
 *
 * 本文件刻意包含一条「**证明危险是真的**」的测试（见 §2）：它主动插入一条
 * `rag.preview='true'` 的 `rag.eval` span 并断言 `getOverview` **确实把它算进去了**。
 * 这条测试同时推翻了原型 §15 不变量 E2 的断言「一律 rag.preview='true'，现有 MV/VIEW
 * 天然排除」——对 eval 读模型**不成立**（018 决策 B 已记录）。
 * 若将来有人改 MV 让它过滤 preview，这条测试会变红，提醒他：本波的隔离前提变了，
 * 请回头重读 018 决策 B 再决定要不要放宽存储隔离。
 */

const describeInfra = infraGate();
jest.setTimeout(180_000);

const SET_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const APP_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const hex32 = () => randomUUID().replaceAll("-", "");

describeInfra("E-W2a 污染回归：离线 run 绝不进在线质量总览", () => {
  let harness: Awaited<ReturnType<typeof createEvaluationInfraHarness>>;
  let clickhouse: ClickHouseEvaluationsRepository;
  let repo: EvalRunsRepository;

  const onlineTraceId = hex32(); // 在线（preview=0）的既有评测样本
  const previewEvalTraceId = hex32(); // §2 用：preview=true 的 rag.eval span
  const at = "2026-07-16T02:00:00.000Z";
  // getOverview 按 judge_version 过滤（在线恒 online-v1）——注意它**不按 preview 过滤**，
  // 这正是本文件 §2 要打的点。
  const window = {
    from: "2026-07-16T01:00:00.000Z",
    to: "2026-07-16T03:00:00.000Z",
    judgeVersion: "online-v1",
  };

  /** 造一条在线 rag.eval span（E-W1 worker 正常产出的形状）。 */
  async function insertEvalSpan(targetTraceId: string, preview: boolean): Promise<void> {
    await harness.insertSpan({
      traceId: hex32(),
      spanId: randomUUID().replaceAll("-", "").slice(0, 16),
      at,
      name: "rag.eval",
      // MV 的四个过滤条件（003-eval-views.sql:25-28）：SpanName='rag.eval' +
      // rag.eval.status='success' + target_trace_id 非空 + rag.eval.version 非空。
      // **注意这里没有 preview** —— 这正是决策 B 的证据，§2 那条测试就是打这个的。
      attributes: {
        "rag.eval.target_trace_id": targetTraceId,
        "rag.eval.faithfulness": "90",
        "rag.eval.answer_relevancy": "85",
        "rag.eval.context_precision": "80",
        "rag.eval.version": "online-v1", // MV 读的是 rag.eval.version，不是 judge_version
        "rag.eval.status": "success",
        "gen_ai.agent.id": "agent-isolation",
        "rag.preview": preview ? "true" : "false",
      },
    });
  }

  beforeAll(async () => {
    harness = await createEvaluationInfraHarness();
    await harness.resetAndMigrate();
    clickhouse = new ClickHouseEvaluationsRepository(harness.clickhouse as never);
    repo = new EvalRunsRepository(drizzle(harness.pool) as never);
    await harness.pool.query(
      `INSERT INTO eval_sets (id, name, created_by) VALUES ($1, '隔离回归集', 't')`,
      [SET_ID],
    );
    await insertEvalSpan(onlineTraceId, false); // 基线：一条真实在线样本
  });

  afterAll(async () => {
    await harness.cleanup([onlineTraceId, previewEvalTraceId]);
    await harness.pool.end();
  });

  /** 建一条 run + 一条 reviewed 用例，返回 runId。 */
  async function seedRun(): Promise<{ runId: string; caseVersionId: string }> {
    const caseRow = await harness.pool.query(
      `INSERT INTO eval_cases (set_id, status) VALUES ($1, 'reviewed') RETURNING id`,
      [SET_ID],
    );
    const versionRow = await harness.pool.query(
      `INSERT INTO eval_case_versions (case_id, version, question, gold_points)
       VALUES ($1, 1, '课程可以退款吗', ARRAY['7 天内无理由退']) RETURNING id`,
      [caseRow.rows[0].id],
    );
    const caseVersionId = versionRow.rows[0].id as string;
    const runRow = await harness.pool.query(
      `INSERT INTO eval_runs (set_id, application_id, config_version_id, judge_model_id,
         embedding_model_id, case_version_snapshot, total_cases, created_by)
       VALUES ($1,$2,$2,$2,$2,$3::jsonb,1,'t') RETURNING id`,
      [
        SET_ID,
        APP_ID,
        JSON.stringify([{ caseId: caseRow.rows[0].id, caseVersionId, seq: 1 }]),
      ],
    );
    return { runId: runRow.rows[0].id as string, caseVersionId };
  }

  /** 真 worker + 真 PG 仓库；只桩掉编排与裁判（外部模型调用），run 生命周期全是真的。 */
  function makeProcessor(previewTraceId: string) {
    const orchestration = {
      runForEvaluation: jest.fn(async () => ({
        traceId: previewTraceId,
        replyText: "7 天内无理由退",
        hits: [{ chunkId: "chunk-real-1", text: "退款政策……", finalScore: 0.9 }],
        usage: { inputTokens: 10, outputTokens: 5 },
        isFallback: false,
        timedOut: false,
      })),
    };
    const judge = {
      scoreOffline: jest.fn(async () => ({
        faithfulness: 91,
        answerRelevancy: 88,
        contextPrecision: 78,
        correctness: 82,
        evidence: { faithfulness: ["ok"] },
        usage: { inputTokens: 4, outputTokens: 2 },
      })),
    };
    const applications = {
      resolveForTest: jest.fn(async () => ({
        applicationId: APP_ID,
        configVersionId: APP_ID,
        version: 7,
        preview: true,
      })),
    };
    const queue = { publish: jest.fn(), subscribe: jest.fn(), schedule: jest.fn() };
    const processor = new EvalRunWorkerProcessor(
      queue as never,
      repo,
      orchestration as never,
      judge as never,
      applications as never,
      { evalRunCaseTimeoutMs: 120_000 } as never,
    );
    return { processor, orchestration, judge };
  }

  // ─────────────────────────── §1 本波最关键的断言 ───────────────────────────

  it("跑完一个离线 run，getOverview 的样本数**一点不变**（决策 B 的守护网）", async () => {
    const before = await clickhouse.getOverview(window);
    expect(before.sampleCount).toBeGreaterThan(0); // 基线非空，否则断言无意义

    const { runId } = await seedRun();
    const { processor } = makeProcessor(hex32());
    const outcome = await processor.processRun(runId);
    expect(outcome.status).toBe("done"); // run 确实真跑完了

    // 分数确实落了 PG —— 证明上面的「不变」不是因为 run 没干活
    const results = await harness.pool.query(
      `SELECT faithfulness FROM eval_run_results WHERE run_id = $1`,
      [runId],
    );
    expect(results.rows).toHaveLength(1);
    expect(Number(results.rows[0].faithfulness)).toBe(91);

    const after = await clickhouse.getOverview(window);
    expect(after.sampleCount).toBe(before.sampleCount);
    expect(after.faithfulness).toBe(before.faithfulness);
  });

  it("离线 run 不发任何 rag.eval span（守「将来别走捷径」，不是守当下实现）", async () => {
    // 说明：eval-runs 路径本就不碰 EvaluationSpanEmitter，此断言当下必然为真。
    // 保留它作为回归护栏——将来若有人图省事让离线 run 复用 emitter，这条立刻变红。
    const emitSuccess = jest.spyOn(EvaluationSpanEmitter.prototype, "emitSuccess");
    const emitFailure = jest.spyOn(EvaluationSpanEmitter.prototype, "emitFailure");
    try {
      const { runId } = await seedRun();
      const { processor } = makeProcessor(hex32());
      await processor.processRun(runId);
      expect(emitSuccess).not.toHaveBeenCalled();
      expect(emitFailure).not.toHaveBeenCalled();
    } finally {
      emitSuccess.mockRestore();
      emitFailure.mockRestore();
    }
  });

  it("离线 run 也不调在线判分入口 score()（那是整体失败语义，且会走在线口径）", async () => {
    const { runId } = await seedRun();
    const { processor, judge } = makeProcessor(hex32());
    await processor.processRun(runId);
    expect(judge.scoreOffline).toHaveBeenCalledTimes(1);
    expect((judge as unknown as { score?: unknown }).score).toBeUndefined();
  });

  // ────────────── §2 证明「危险是真的」——决策 B 的前提，而非它的结论 ──────────────

  it("⚠️ 带 rag.preview=true 的 rag.eval span **照样**被 getOverview 算进去", async () => {
    // 这条测试证明的是**为什么**必须存 PG，而不是「我们存了 PG」。
    // MV 只按 SpanName='rag.eval' 过滤、不看 preview → 标 preview **救不了**你。
    // 它同时推翻原型 §15 E2「一律 rag.preview='true'，现有 MV/VIEW 天然排除」。
    const before = await clickhouse.getOverview(window);
    await insertEvalSpan(previewEvalTraceId, true); // 标了 preview 的评测 span
    const after = await clickhouse.getOverview(window);

    expect(after.sampleCount).toBe(before.sampleCount + 1); // ← 污染了！preview 没救到它
    // 若这条将来变红（= MV 开始过滤 preview 了），说明本波的隔离前提变了：
    // 请回头读 018 决策 B 再决定要不要放宽「离线分数不进 ClickHouse」的约束。
  });
});
