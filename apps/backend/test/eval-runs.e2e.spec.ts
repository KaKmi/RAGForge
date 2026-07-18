import { randomUUID } from "node:crypto";
import type { ExecutionContext, INestApplication } from "@nestjs/common";
import { APP_GUARD, APP_PIPE } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { ZodValidationPipe } from "nestjs-zod";
import request from "supertest";
import { applyGlobalConfig } from "../src/app/app-bootstrap";
import { EvalRunWorkerProcessor } from "../src/modules/eval-runs/eval-run-worker.processor";
import { EvalRunsController } from "../src/modules/eval-runs/eval-runs.controller";
import { EvalRunsRepository } from "../src/modules/eval-runs/eval-runs.repository";
import { EvalRunsService } from "../src/modules/eval-runs/eval-runs.service";
import { EvalSetsController } from "../src/modules/eval-runs/eval-sets.controller";
import { EvalSetsRepository } from "../src/modules/eval-runs/eval-sets.repository";
import { EvalSetsService } from "../src/modules/eval-runs/eval-sets.service";
import { ClickHouseEvaluationsRepository } from "../src/modules/evaluations/clickhouse-evaluations.repository";
import { EvaluationsController } from "../src/modules/evaluations/evaluations.controller";
import { EvaluationsRepository } from "../src/modules/evaluations/evaluations.repository";
import { EvaluationsService } from "../src/modules/evaluations/evaluations.service";
import type { TokenUsage } from "../src/modules/evaluations/evaluation.types";
import {
  createEvaluationInfraHarness,
  E2E_EMBED_MODEL_ID,
  E2E_JUDGE_MODEL_ID,
} from "./helpers/evaluation-infra";
import { infraGate } from "./helpers/gated-suite";

/**
 * ══════════════════════════════════════════════════════════════════════════════
 *  E-W2a 验收标准 §9 的 **HTTP + 真 SQL** 端到端守护网。
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 与既有测试的分工（刻意不重复，各守各的层）：
 *  · `eval-runs.service.spec.ts` / `eval-run-worker.processor.spec.ts` —— 单元层，
 *    **仓库全是 fake**。dev-ledger 已记教训：「租约/回收的性质活在 SQL 三值逻辑上，
 *    fake 复刻不出来；把 P1 完整回退，875 条单测全绿」。故这些用例证明不了 SQL 口径。
 *  · `eval-runs.lease.db.spec.ts` —— 真 PG，但只覆盖租约/回收，**不过 HTTP**。
 *  · `eval-run-isolation.spec.ts` —— 真 PG + 真 ClickHouse 的污染回归，但**直接调 worker**，
 *    不经 controller/DTO。
 *  · **本文件** —— 唯一一条 `controller → Zod DTO → service → 真仓库 → 真 PG` 的全链路：
 *    记分卡聚合 SQL、`case_version_snapshot` 的 jsonb 往返、「最差指标升序」排序 SQL、
 *    HTTP 状态码（201/409/422）都只有在这里才是真的。
 *
 * **外部模型调用**（编排 / 裁判）按既有 infra 测试的一贯做法打桩（`evaluations.e2e.spec.ts`
 * 用 fakeModels、`eval-run-isolation.spec.ts` 桩编排与裁判）：run 生命周期、状态机、
 * 事务与全部 SQL 都是真的，只有「调外部大模型」这一步是桩。
 */

const describeInfra = infraGate();
jest.setTimeout(180_000);

const hex32 = () => randomUUID().replaceAll("-", "");
const hex16 = () => hex32().slice(0, 16);

/**
 * N 方汇合闸：前 N−1 个到达者挂起，第 N 个到达时一起放行。
 *
 * 用途见「缺口 13」的 TOCTOU 用例：真并发下两个请求**是否**同时落在
 * 预检与 INSERT 之间的窗口里，取决于事件循环与连接池的调度，靠 `Promise.all`
 * 碰运气会是 flake 之源（碰不上时预检先命中，测的就不是唯一索引了）。
 * 用闸把「两个请求都已越过预检、都停在插入点」变成**确定性**前置条件，
 * 于是那条 409 只可能来自真库的原子兜底。
 */
function createBarrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= parties) release();
    await gate;
  };
}

const APP_ID = randomUUID();
const CONFIG_VERSION_ID = randomUUID();
const ACTOR = "e2e@codecrush.dev";
/** 污染回归的基线样本挂在这个 agent 上——用它把 overview 窗口钉死，与库里其他行隔离。 */
const AGENT_ID = `agent-w2a-e2e-${hex32().slice(0, 8)}`;
const SPAN_AT = "2026-07-16T02:00:00.000Z";
const FROM = "2026-07-16T01:00:00.000Z";
const TO = "2026-07-16T03:00:00.000Z";

/** 编排每条用例上报的 usage（决策 G：只累加已上报部分）。 */
const ORCHESTRATION_USAGE: TokenUsage = { inputTokens: 10, outputTokens: 5 };
const JUDGE_USAGE: TokenUsage = { inputTokens: 4, outputTokens: 2 };
/** 单条用例的总计量 = 编排 15 + 裁判 6 = 21（预算熔断测试据此挑阈值）。 */
const TOKENS_PER_CASE =
  ORCHESTRATION_USAGE.inputTokens +
  ORCHESTRATION_USAGE.outputTokens +
  JUDGE_USAGE.inputTokens +
  JUDGE_USAGE.outputTokens;

const GOOD_QUESTION = "课程可以退款吗";
const CORRECTNESS_FAILS_QUESTION = "发票怎么开";

describeInfra("E-W2a 离线评测闭环（HTTP e2e，真 PG + 真 ClickHouse）", () => {
  let app: INestApplication;
  let harness: Awaited<ReturnType<typeof createEvaluationInfraHarness>>;
  let evalRunsRepo: EvalRunsRepository;
  let evalSetsRepo: EvalSetsRepository;
  /** 本轮测试产生的 preview trace —— afterAll 交给 harness.cleanup 清 ClickHouse。 */
  const previewTraceIds: string[] = [];
  const onlineTraceId = hex32();

  const applications = {
    // 018 决策 C：离线 run 走**显式版本**解析（preview=true），不是 resolvePublic。
    resolveForTest: jest.fn(async () => ({
      applicationId: APP_ID,
      configVersionId: CONFIG_VERSION_ID,
      version: 7,
      preview: true,
    })),
    listVersions: jest.fn(async () => [{ id: CONFIG_VERSION_ID, version: 7 }]),
  };
  /** run 由测试显式驱动（processRun），故 publish 只记账不真入队——避免依赖 pg-boss 的异步时序。 */
  const queue = { publish: jest.fn(), subscribe: jest.fn(), schedule: jest.fn() };
  const fakeModels = {
    get: jest.fn(async (id: string) => ({
      id,
      name: id === E2E_JUDGE_MODEL_ID ? "e2e-judge" : "e2e-embed",
      type: id === E2E_JUDGE_MODEL_ID ? "llm" : "embedding",
      enabled: true,
    })),
    list: jest.fn(async () => [
      { id: E2E_JUDGE_MODEL_ID, name: "e2e-judge", type: "llm", enabled: true },
      { id: E2E_EMBED_MODEL_ID, name: "e2e-embed", type: "embedding", enabled: true },
    ]),
  };

  beforeAll(async () => {
    harness = await createEvaluationInfraHarness();
    await harness.resetAndMigrate();
    evalRunsRepo = new EvalRunsRepository(harness.db as never);
    evalSetsRepo = new EvalSetsRepository(harness.db as never);

    const setsService = new EvalSetsService(evalSetsRepo);
    const runsService = new EvalRunsService(
      evalRunsRepo,
      evalSetsRepo,
      applications as never,
      queue as never,
    );
    const evaluationsService = new EvaluationsService(
      new EvaluationsRepository(harness.db as never),
      new ClickHouseEvaluationsRepository(harness.clickhouse),
      fakeModels as never,
    );

    const ref = await Test.createTestingModule({
      controllers: [EvalSetsController, EvalRunsController, EvaluationsController],
      providers: [
        { provide: EvalSetsService, useValue: setsService },
        { provide: EvalRunsService, useValue: runsService },
        { provide: EvaluationsService, useValue: evaluationsService },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        {
          // 放行鉴权但**必须挂上 user**：两个 controller 都读 `req.user.email` 当 actor
          // （created_by 非空列），不挂会 500 而不是业务错误。
          provide: APP_GUARD,
          useValue: {
            canActivate: (ctx: ExecutionContext) => {
              ctx.switchToHttp().getRequest().user = { id: "u-e2e", email: ACTOR };
              return true;
            },
          },
        },
      ],
    }).compile();
    app = ref.createNestApplication();
    applyGlobalConfig(app);
    await app.init();

    // 污染回归的基线：一条**在线**（preview=false）评测样本，让 overview 的样本数非 0。
    await insertOnlineEvalSpan(onlineTraceId);
  });

  afterEach(async () => {
    // run 是**全局串行**的（任一 queued/running 都会让下一个 POST 收 409）→ 每条用例后必须
    // 清空，否则一条测试留下的 run 会把后面所有测试连坐成 409。顺序按 FK 依赖。
    await harness.pool.query("DELETE FROM eval_run_results");
    await harness.pool.query("DELETE FROM eval_runs");
    await harness.pool.query("DELETE FROM eval_case_versions");
    await harness.pool.query("DELETE FROM eval_cases");
    await harness.pool.query("DELETE FROM eval_sets");
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
    await harness.cleanup([onlineTraceId, ...previewTraceIds]);
    await harness.close();
  });

  /** 一条在线 rag.eval span（E-W1 worker 的正常产出形状）——MV 的四个过滤条件齐全。 */
  async function insertOnlineEvalSpan(targetTraceId: string): Promise<void> {
    await harness.insertSpan({
      traceId: hex32(),
      spanId: hex16(),
      at: SPAN_AT,
      name: "rag.eval",
      attributes: {
        "rag.eval.target_trace_id": targetTraceId,
        "rag.eval.faithfulness": "90",
        "rag.eval.answer_relevancy": "85",
        "rag.eval.context_precision": "80",
        "rag.eval.version": "online-v2",
        "rag.eval.status": "success",
        "gen_ai.agent.id": AGENT_ID,
        "rag.preview": "false",
      },
    });
  }

  // ─────────────────────────────── HTTP 小工具 ───────────────────────────────

  const http = () => request(app.getHttpServer());

  async function createSet(name: string): Promise<string> {
    const res = await http().post("/api/eval/sets").send({ name }).expect(201);
    return res.body.id as string;
  }

  async function addCase(setId: string, question: string, goldPoints: string[]): Promise<string> {
    const res = await http()
      .post(`/api/eval/sets/${setId}/cases`)
      .send({ question, goldPoints })
      .expect(201);
    expect(res.body.status).toBe("draft"); // 原型 §18.B：新建恒 draft，不参与 run
    return res.body.id as string;
  }

  async function review(setId: string, caseId: string): Promise<void> {
    await http()
      .patch(`/api/eval/sets/${setId}/cases/${caseId}`)
      .send({ status: "reviewed" })
      .expect(200);
  }

  function startRun(setId: string, body: Record<string, unknown> = {}) {
    return http()
      .post("/api/eval/runs")
      .send({
        setId,
        applicationId: APP_ID,
        configVersionId: CONFIG_VERSION_ID,
        judgeModelId: E2E_JUDGE_MODEL_ID,
        embeddingModelId: E2E_EMBED_MODEL_ID,
        ...body,
      });
  }

  /** 建集 + N 条「已审核（带 gold）」用例，返回 setId。 */
  async function seedReviewedSet(name: string, questions: string[]): Promise<string> {
    const setId = await createSet(name);
    for (const question of questions) {
      const caseId = await addCase(setId, question, [`${question}的 gold 要点`]);
      await review(setId, caseId);
    }
    return setId;
  }

  async function overviewEvaluatedCount(): Promise<number> {
    const res = await http()
      .get("/api/eval/quality/overview")
      .query({ from: FROM, to: TO, agentId: AGENT_ID })
      .expect(200);
    return res.body.meta.evaluatedCount as number;
  }

  // ─────────────────────────────── worker 装配 ───────────────────────────────

  interface WorkerOptions {
    /** true = 编排超时（返回 timedOut，不抛）。 */
    timedOut?: boolean;
    /** 模拟真编排把 rag.pipeline preview span 写进 ClickHouse（真编排行为见 orchestration.service.spec.ts:737）。 */
    recordPreviewSpan?: boolean;
    /** 每条用例的编排调用结束后触发（停止测试用它在跑第 1 条时发停止信号）。 */
    onCase?: (callIndex: number) => Promise<void>;
  }

  /**
   * 真 worker + 真 PG 仓库；只桩掉编排与裁判（= 外部模型调用）。
   * run 生命周期、租约、事务、状态机全部是真的。
   */
  function makeWorker(options: WorkerOptions = {}) {
    let calls = 0;
    const orchestration = {
      runForEvaluation: jest.fn(
        async (_cfg: unknown, question: string, opts: { runId: string; timeoutMs: number }) => {
          const traceId = hex32();
          previewTraceIds.push(traceId);
          calls += 1;
          if (options.recordPreviewSpan) {
            // 真编排在 chain 根 span 上标 rag.preview=true + rag.eval.run_id（决策 B）。
            // 这里如实复刻那个形状，好让下面的断言能在**真 ClickHouse** 上验证
            // 「这个形状的 trace 不进 eval 读模型」。
            await harness.insertSpan({
              traceId,
              spanId: hex16(),
              at: SPAN_AT,
              name: "rag.pipeline",
              attributes: {
                "codecrush.span.kind": "chain",
                "rag.preview": "true",
                "rag.eval.run_id": opts.runId,
                "gen_ai.agent.id": AGENT_ID,
                "codecrush.io.input": question,
              },
            });
          }
          await options.onCase?.(calls);
          return {
            traceId,
            replyText: `答：${question}`,
            // 真实 chunkId（禁止合成）——编排的 TaggedHit 原样透出。
            hits: [{ chunkId: `chunk-${calls}`, text: "退款政策……", finalScore: 0.9 }],
            usage: ORCHESTRATION_USAGE,
            isFallback: false,
            timedOut: options.timedOut ?? false,
          };
        },
      ),
    };
    const judge = {
      // 签名与真 scoreOffline 一致：(input, modelIds, goldPoints)。
      scoreOffline: jest.fn(async (input: { question: string }) =>
        input.question === CORRECTNESS_FAILS_QUESTION
          ? {
              // 单指标（correctness）裁判失败 → 该指标 null，其余照常出分（§9.10）。
              faithfulness: 90,
              answerRelevancy: 86,
              contextPrecision: 82,
              correctness: null,
              evidence: { faithfulness: ["有据可依"] },
              usage: JUDGE_USAGE,
            }
          : {
              faithfulness: 92,
              answerRelevancy: 88,
              contextPrecision: 84,
              correctness: 90,
              evidence: { faithfulness: ["有据可依"], correctness: ["要点全中"] },
              usage: JUDGE_USAGE,
            },
      ),
    };
    const processor = new EvalRunWorkerProcessor(
      queue as never,
      evalRunsRepo,
      orchestration as never,
      judge as never,
      applications as never,
      { evalRunCaseTimeoutMs: 120_000 } as never,
    );
    return { processor, orchestration, judge };
  }

  // ══════════════════════ §9.5 全链路：建集 → 用例 → 审核 → run → 报告 ══════════════════════

  it("§9.5 全链路：建集 → 加用例 → 审核 → 发起 run → run done → 报告出分", async () => {
    const setId = await createSet("售后核心题库");

    const goldCaseId = await addCase(setId, GOOD_QUESTION, ["7 天内无理由退"]);
    const failCaseId = await addCase(setId, CORRECTNESS_FAILS_QUESTION, ["联系客服开票"]);
    // 无 gold 的用例：可以建（draft），但**不可审核**——reviewed 要求 ≥1 gold 要点（§19.1）。
    const noGoldCaseId = await addCase(setId, "客服电话多少", []);

    await review(setId, goldCaseId);
    await review(setId, failCaseId);
    // §19.1 逐字文案 + 「reviewed 必有 gold」是**状态不变式**（commit 212a980）。
    // 它正是下面 totalCases=2 的原因：无 gold 用例永远进不了 run 候选集。
    await http()
      .patch(`/api/eval/sets/${setId}/cases/${noGoldCaseId}`)
      .send({ status: "reviewed" })
      .expect(422)
      .expect((res) => expect(res.body.message).toBe("至少填写 1 个答案要点"));

    const created = await startRun(setId).expect(201);
    const runId = created.body.id as string;
    expect(created.body).toMatchObject({
      status: "queued",
      totalCases: 2, // draft 的无 gold 用例被排除（原型 §18.B）
      doneCases: 0,
      overallScore: null,
      configVersionLabel: "v7",
      setName: "售后核心题库",
    });
    expect(queue.publish).toHaveBeenCalledTimes(1);

    const { processor } = makeWorker();
    expect((await processor.processRun(runId)).status).toBe("done");

    const report = (await http().get(`/api/eval/runs/${runId}`).expect(200)).body;

    expect(report.run).toMatchObject({ status: "done", doneCases: 2, totalCases: 2 });
    expect(report.run.offlineJudgeVersion).toBe("offline-v2"); // 当前离线量具版本
    expect(report.run.tokensUsed).toBe(TOKENS_PER_CASE * 2);
    expect(report.skipped).toEqual([]);

    const byQuestion = new Map<string, Record<string, unknown>>(
      report.results.map((row: { question: string }) => [row.question, row]),
    );

    // ① 有 gold 且裁判全通 → 四个分数齐全。
    expect(byQuestion.get(GOOD_QUESTION)).toMatchObject({
      faithfulness: 92,
      answerRelevancy: 88,
      contextPrecision: 84,
      correctness: 90,
      minMetric: "contextPrecision",
      minScore: 84,
      verdict: "pass",
      caseVersion: 1,
    });

    // ② 单指标裁判失败 → 该指标 **null**，**绝不是 0**，其余照常出分（§9.10）。
    const failed = byQuestion.get(CORRECTNESS_FAILS_QUESTION)!;
    expect(failed).toMatchObject({
      faithfulness: 90,
      answerRelevancy: 86,
      contextPrecision: 82,
      correctness: null,
      verdict: "pass",
    });
    expect(failed.correctness).not.toBe(0); // 口径守卫：NULL ≠ 0（原型 §6「不拉低均值」）

    // ③ 每条结果都有可跳转的 preview trace（原型 §7 的「trace」链接）。
    for (const row of report.results) {
      expect(row.previewTraceId).toMatch(/^[a-f0-9]{32}$/);
    }

    // ④ 记分卡：avg 只对**非 NULL** 样本算，覆盖率显性回传（决策 D + 原型 §6）。
    //    correctness 只有 1 条评出来 → 分母是 1 不是 2，值是 90 不是 45。
    expect(report.scorecard).toMatchObject({
      retrieval: { contextPrecision: { value: 83, scoredCount: 2, total: 2 } },
      generation: {
        faithfulness: { value: 91, scoredCount: 2, total: 2 },
        answerRelevancy: { value: 87, scoredCount: 2, total: 2 },
        correctness: { value: 90, scoredCount: 1, total: 2 },
      },
      passCount: 2,
      weakCount: 0,
      lowCount: 0,
      timeoutCount: 0,
      unscoredCount: 0,
      skippedCount: 0,
    });

    // ⑤ 报告默认按「最差指标升序」（坏的浮顶——原型 §7）：82 在 84 前。
    expect(report.results.map((row: { minScore: number }) => row.minScore)).toEqual([82, 84]);
  });

  it("§9.5 离线 run 不落会话：conversations 表**一行不增**（决策 C-2 的 persist=false）", async () => {
    const before = await harness.pool.query("SELECT count(*)::int AS n FROM conversations");

    const setId = await seedReviewedSet("不落会话集", [GOOD_QUESTION, "发货要多久"]);
    const runId = (await startRun(setId).expect(201)).body.id as string;
    const { processor } = makeWorker();
    expect((await processor.processRun(runId)).status).toBe("done");

    const after = await harness.pool.query("SELECT count(*)::int AS n FROM conversations");
    // 一个 50 题的 run 若落会话会灌 50 行，且与真实用户会话**不可区分**（conversations 无 preview 列）。
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(await harness.pool.query("SELECT count(*)::int AS n FROM messages")).toMatchObject({
      rows: [{ n: 0 }],
    });
  });

  // ══════════════════ §9.5 本波最关键断言：离线 run 绝不污染屏1 ══════════════════

  it("§9.5 污染回归：跑完离线 run 后 GET /eval/quality/overview 的样本数**一点不变**", async () => {
    const before = await overviewEvaluatedCount();
    expect(before).toBeGreaterThan(0); // 基线非空，否则「不变」是废话

    // 跑 run 前后各数一次 rag.eval span：这是**存储层**证据，比「emitter 没被调用」更硬。
    const evalSpansBefore = await countEvalSpans();

    const setId = await seedReviewedSet("污染回归集", [GOOD_QUESTION]);
    const runId = (await startRun(setId).expect(201)).body.id as string;
    const { processor } = makeWorker({ recordPreviewSpan: true });
    expect((await processor.processRun(runId)).status).toBe("done");

    // 分数确实落了 PG —— 证明下面的「不变」不是因为 run 根本没干活。
    const report = (await http().get(`/api/eval/runs/${runId}`).expect(200)).body;
    expect(report.results).toHaveLength(1);
    expect(report.results[0].faithfulness).toBe(92);

    // ① run 的 preview trace 在 ClickHouse 里确实是 preview=1 且带 rag.eval.run_id。
    const previewTraceId = report.results[0].previewTraceId as string;
    const span = await fetchSpan(previewTraceId);
    expect(span).toMatchObject({
      SpanName: "rag.pipeline", // 是编排 trace，**不是** rag.eval 评测 span
      preview: "true",
      run_id: runId,
    });

    // ② 即便如此，屏1 的样本数与三指标**一点不变**：隔离靠**存储物理分离**（分数只在 PG），
    //    不靠过滤 —— MV 只按 SpanName='rag.eval' 收，而 run 只产 rag.pipeline。
    expect(await overviewEvaluatedCount()).toBe(before);

    // ③ run 引擎没有新增任何 rag.eval span（存储层反证「将来别走捷径」）。
    expect(await countEvalSpans()).toBe(evalSpansBefore);
  });

  // ═══════════════════════ §9.6 / §9.7 停止与预算熔断 ═══════════════════════

  it("run id 路径与 compare 查询参数非法时返回 400，而不是存储层 500", async () => {
    await http().post("/api/eval/runs/not-a-uuid/stop").expect(400);
    await http().get("/api/eval/runs/not-a-uuid").expect(400);
    await http().get("/api/eval/runs/compare?a=not-a-uuid&b=also-invalid").expect(400);
  });

  it("§9.6 停止：running 中 stop → 已完成结果保留、run=partial、未跑用例显示为 skipped", async () => {
    const setId = await seedReviewedSet("停止集", [GOOD_QUESTION, "发货要多久", "怎么换货"]);
    const runId = (await startRun(setId).expect(201)).body.id as string;

    // 在第 1 条用例的编排过程中发停止信号 → 第 1 条照常落库，第 2 条开跑前的检查命中 → 收 partial。
    const { processor } = makeWorker({
      onCase: async (index) => {
        if (index === 1) await http().post(`/api/eval/runs/${runId}/stop`).expect(204);
      },
    });
    expect((await processor.processRun(runId)).status).toBe("partial");

    const report = (await http().get(`/api/eval/runs/${runId}`).expect(200)).body;
    expect(report.run).toMatchObject({ status: "partial", doneCases: 1, totalCases: 3 });
    expect(report.results).toHaveLength(1); // 已完成的**保留**
    expect(report.results[0].question).toBe(GOOD_QUESTION);
    // 未跑到的用例**不写结果行** → 由 snapshot − 结果行推导 skipped（原型 §18.A）。
    expect(report.skipped.map((row: { seq: number }) => row.seq)).toEqual([2, 3]);
    expect(report.skipped[0].question).toBe("发货要多久");
    expect(report.scorecard.skippedCount).toBe(2);

    // 终态不可再停（报告不可变）——原型 §18.A。
    await http().post(`/api/eval/runs/${runId}/stop`).expect(409);
  });

  it("§9.7 预算：token_budget 调小 → run 自动停并标 budget_stop", async () => {
    const setId = await seedReviewedSet("预算集", [GOOD_QUESTION, "发货要多久"]);
    const runId = (await startRun(setId).expect(201)).body.id as string;
    // 预算 = 不足一条用例的量（单条 21）→ 第 1 条跑完即超，第 2 条开跑前熔断。
    await harness.pool.query("UPDATE eval_runs SET token_budget = $1 WHERE id = $2", [
      TOKENS_PER_CASE - 1,
      runId,
    ]);

    const { processor } = makeWorker();
    expect((await processor.processRun(runId)).status).toBe("budget_stop");

    const report = (await http().get(`/api/eval/runs/${runId}`).expect(200)).body;
    expect(report.run).toMatchObject({ status: "budget_stop", doneCases: 1 });
    expect(report.results).toHaveLength(1);
    expect(report.skipped).toHaveLength(1);
    expect(report.run.tokensUsed).toBe(TOKENS_PER_CASE);
  });

  // ═══════════════════════════ §9.8 幂等与并发 ═══════════════════════════

  it("§9.8 幂等：1h 内同 set×版本再 POST → 409 recent_run_exists；force=true 可强跑", async () => {
    const setId = await seedReviewedSet("幂等集", [GOOD_QUESTION]);
    const firstId = (await startRun(setId).expect(201)).body.id as string;
    const { processor } = makeWorker();
    expect((await processor.processRun(firstId)).status).toBe("done");

    // 原型 §19.2：「1 小时内已有相同评测结果 · 查看 / 仍重新运行」——前端据 code 弹选择框。
    //
    // ⚠️ 这里钉的是**线上真实体形状**，前端的 409 分流全靠它（client.ts:916-921）：
    // Nest 对**对象**入参直接把它当响应体（不包 message/statusCode），故幂等 409 是
    // 裸的 `{code, recentRunId}`，而全局串行 409 是普通的 `{message}`（见下一条用例）。
    // 两者形状不同正是「按形状分流」的前提 —— 若哪天有人给它包一层 message，
    // 前端会把幂等冲突当普通报错弹，「查看 / 仍重新运行」的选择框就没了。
    const conflict = await startRun(setId).expect(409);
    expect(conflict.body).toEqual({ code: "recent_run_exists", recentRunId: firstId });
    expect(conflict.body.message).toBeUndefined(); // 形状分流的前提：幂等体没有 message 键

    // 「仍重新运行」→ force=true 跳过幂等复用。
    const forced = await startRun(setId, { force: true }).expect(201);
    expect(forced.body.id).not.toBe(firstId);
    expect(forced.body.status).toBe("queued");
  });

  it("§9.8 并发：已有 queued/running 的 run 时再 POST → 409（全局同时最多 1 个 run）", async () => {
    const setId = await seedReviewedSet("并发集", [GOOD_QUESTION]);
    await startRun(setId).expect(201); // 留在 queued，不驱动

    // 与幂等的 409 不同：这条没有 recentRunId，是「有 run 在跑」的诚实拒绝。
    const conflict = await startRun(setId).expect(409);
    expect(conflict.body.message).toBe("已有评测正在运行，请等待完成或先停止");
    // force 也绕不过全局串行（串行守卫在幂等检查之前）。
    await startRun(setId, { force: true }).expect(409);
  });

  // ═══════════════ 缺口 13：全局「同时至多 1 个活跃 run」的原子性（HTTP 层） ═══════════════
  //
  // 与紧邻上面那条 §9.8 的分工（刻意不重复）：
  //  · §9.8 是**串行**的——第一个 POST 已经返回后才发第二个，命中的是 service 的
  //    `findActiveRun()` 快速路径。它证明不了并发安全：那条预检与 INSERT 之间既无事务
  //    也无锁，两个请求本来就能双双越过它（018 §12 缺口 13 的 TOCTOU）。
  //  · 下面两条钉的是**并发**语义，且经真 HTTP + 真唯一索引。

  /** 库里当前 queued/running 的行数——「至多 1」这个不变式的唯一权威判据。 */
  async function activeRunCount(): Promise<number> {
    const res = await harness.pool.query(
      "SELECT count(*)::int AS n FROM eval_runs WHERE status IN ('queued','running')",
    );
    return res.rows[0].n as number;
  }

  it("缺口 13 · 真并发同时 POST /api/eval/runs → 恰好 1 个 201 + 1 个 409，库里只留 1 条活跃 run", async () => {
    const setId = await seedReviewedSet("并发双开集", [GOOD_QUESTION]);

    // 同一轮事件循环里一起发出，不等第一个返回。
    const results = await Promise.all([startRun(setId), startRun(setId)]);
    const statuses = results.map((r) => r.status).sort((a, b) => a - b);

    // 无论 409 由预检还是由唯一索引给出，对调用方可见的结论必须是同一条：只有一个赢家。
    expect(statuses).toEqual([201, 409]);
    expect(await activeRunCount()).toBe(1);

    const created = results.find((r) => r.status === 201)!;
    const rejected = results.find((r) => r.status === 409)!;
    expect(created.body.status).toBe("queued");
    // 两条 409 路径（预检 / 23505 兜底）抛的是同一个 ConflictException ⇒ 文案对调用方一致，
    // 且**不是**幂等冲突那种裸 `{code, recentRunId}` 形状（前端按形状分流，见 §9.8 注释）。
    expect(rejected.body.message).toBe("已有评测正在运行，请等待完成或先停止");
    expect(rejected.body.code).toBeUndefined();
  });

  it("缺口 13 · 两个请求双双越过预检（TOCTOU 窗口）→ 唯一索引原子兜底仍是 1 个 201 + 1 个 409", async () => {
    const setId = await seedReviewedSet("TOCTOU 集", [GOOD_QUESTION]);

    // 闸设在**插入点**上：两个请求都到齐才放行 ⇒ 两者都已越过 `findActiveRun()` 预检
    // （此刻库里还是空的，预检本就放行），预检因此在本用例里完全出局。
    // 于是那条 409 只可能来自 `eval_runs_single_active_unique` 的 23505 → ConflictException。
    const barrier = createBarrier(2);
    const realInsertRun = evalRunsRepo.insertRun.bind(evalRunsRepo);
    const insertSpy = jest
      .spyOn(evalRunsRepo, "insertRun")
      .mockImplementation(async (input: Parameters<typeof realInsertRun>[0]) => {
        await barrier();
        return await realInsertRun(input);
      });

    try {
      const results = await Promise.all([startRun(setId), startRun(setId)]);
      const statuses = results.map((r) => r.status).sort((a, b) => a - b);

      // 两个请求确实都到了插入点（= 预检双双放行），否则本用例测的就不是原子兜底。
      expect(insertSpy).toHaveBeenCalledTimes(2);
      expect(statuses).toEqual([201, 409]);
      // 真库的原子性：两条 INSERT 都发出去了，只有一条落了地。
      expect(await activeRunCount()).toBe(1);

      const rejected = results.find((r) => r.status === 409)!;
      // AC5：兜底 409 的响应体与既有全局串行 409 **逐字节相同**——前端按形状分流，
      // 若哪天有人给它换文案或包一层 code，并发那一路会在前端被当成另一类错误。
      expect(rejected.body).toEqual({
        message: "已有评测正在运行，请等待完成或先停止",
        error: "Conflict",
        statusCode: 409,
      });
    } finally {
      insertSpy.mockRestore();
    }
  });

  it("§9.8 空集：0 条已审核用例 → 422「所选范围没有已审核用例」（原型 §19.2 逐字）", async () => {
    const setId = await createSet("空集");
    await addCase(setId, GOOD_QUESTION, ["要点"]); // 只有 draft，没审核
    await startRun(setId)
      .expect(422)
      .expect((res) => expect(res.body.message).toBe("所选范围没有已审核用例"));
  });

  // ═════════════════════ §9.9 用例版本不可变（历史报告冻结） ═════════════════════

  it("§9.9 用例改内容后，旧 run 报告仍显示**改动前**的问题；已审核用例编辑后仍 reviewed(v+1)", async () => {
    const setId = await createSet("版本冻结集");
    const caseId = await addCase(setId, GOOD_QUESTION, ["7 天内无理由退"]);
    await review(setId, caseId);

    const runId = (await startRun(setId).expect(201)).body.id as string;
    const { processor } = makeWorker();
    expect((await processor.processRun(runId)).status).toBe("done");

    // 编辑内容 → 新版本 v2；status **不回退 draft**（原型 §18.B）。
    const edited = await http()
      .patch(`/api/eval/sets/${setId}/cases/${caseId}`)
      .send({ question: "课程可以退款吗（改过的）" })
      .expect(200);
    expect(edited.body).toMatchObject({ version: 2, status: "reviewed" });

    // 历史报告引用的是**冻结的 v1**——快照按 caseVersionId 存，不查当前最新版。
    const report = (await http().get(`/api/eval/runs/${runId}`).expect(200)).body;
    expect(report.results[0]).toMatchObject({ question: GOOD_QUESTION, caseVersion: 1 });
  });

  // ═══════════════════════════ ClickHouse 读工具 ═══════════════════════════

  /** 本测试 agent 名下的 rag.eval span 条数（污染回归的存储层证据）。 */
  async function countEvalSpans(): Promise<number> {
    const result = await harness.clickhouse.query({
      query: `SELECT count() AS n FROM otel_traces
              WHERE SpanName = 'rag.eval' AND SpanAttributes['gen_ai.agent.id'] = {agentId:String}`,
      query_params: { agentId: AGENT_ID },
      format: "JSONEachRow",
    });
    const [row] = await result.json<{ n: string }>();
    return Number(row?.n ?? 0);
  }

  async function fetchSpan(traceId: string) {
    const result = await harness.clickhouse.query({
      query: `SELECT SpanName,
                     SpanAttributes['rag.preview'] AS preview,
                     SpanAttributes['rag.eval.run_id'] AS run_id
              FROM otel_traces WHERE TraceId = {traceId:String} LIMIT 1`,
      query_params: { traceId },
      format: "JSONEachRow",
    });
    const [row] = await result.json();
    return row;
  }
});
