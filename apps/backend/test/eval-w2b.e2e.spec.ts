import { randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";
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
import { ReplayService } from "../src/modules/eval-runs/replay.service";
import { ClickHouseEvaluationsRepository } from "../src/modules/evaluations/clickhouse-evaluations.repository";
import { EvaluationsRepository } from "../src/modules/evaluations/evaluations.repository";
import type { TokenUsage } from "../src/modules/evaluations/evaluation.types";
import {
  createEvaluationInfraHarness,
  E2E_EMBED_MODEL_ID,
  E2E_JUDGE_MODEL_ID,
} from "./helpers/evaluation-infra";
import { infraGate } from "./helpers/gated-suite";

/**
 * ══════════════════════════════════════════════════════════════════════════════
 *  E-W2b 验收标准的 **HTTP + 真 SQL（+ 真 ClickHouse）** 端到端守护网。
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 分工（刻意不与 dev 已写的单测重复——各守各层）：
 *  · `eval-run-aggregate.spec.ts` / `retrieval-gold-metrics.spec.ts` / `eval-compare.spec.ts`
 *    —— 纯函数/单元层，仓库全是 fake，证明不了「聚合 SQL 往返 + repeat 唯一索引 + 记分卡
 *    覆盖率」在真 PG 上成立。
 *  · **本文件** —— 唯一一条 `controller → Zod DTO → service → 真仓库 → 真 PG` 的 W2b 全链路：
 *    F5 每题重复（AC5-1/AC5-3）、F2 gold 检索指标（AC2-2）、F8 屏4 对比（AC8-1/AC8-2），
 *    以及 F7 重放隔离（AC7-1/AC7-2/AC7-4/AC7-3，真 ClickHouse，沿 `eval-run-isolation.spec.ts` 模式）。
 *
 * **外部模型调用**（编排 / 裁判）按既有 infra 测试一贯做法打桩：run/replay 生命周期、状态机、
 * 事务、全部 SQL、隔离物理分离都是真的，只有「调外部大模型」这一步是桩。
 *
 * infra 门控与既有 e2e 一致（`RUN_DB_TESTS=1 && RUN_CLICKHOUSE_TESTS=1 && MIGRATION_TEST_DATABASE_URL`）：
 * 无 infra 时整体 `describe.skip`。QA 起 `docker compose --profile infra up --wait` 后运行。
 */

const describeInfra = infraGate();
jest.setTimeout(180_000);

const hex32 = () => randomUUID().replaceAll("-", "");
const hex16 = () => hex32().slice(0, 16);

const APP_ID = randomUUID();
const CONFIG_VERSION_ID = randomUUID();
const ACTOR = "e2e-w2b@codecrush.dev";
/** 隔离回归的基线样本挂这个 agent 上，把 overview 窗口钉死。 */
const AGENT_ID = `agent-w2b-e2e-${hex32().slice(0, 8)}`;
const SPAN_AT = "2026-07-17T02:00:00.000Z";
const FROM = "2026-07-17T01:00:00.000Z";
const TO = "2026-07-17T03:00:00.000Z";

const ORCHESTRATION_USAGE: TokenUsage = { inputTokens: 10, outputTokens: 5 };
const JUDGE_USAGE: TokenUsage = { inputTokens: 4, outputTokens: 2 };

const GOOD_QUESTION = "课程可以退款吗";
const SECOND_QUESTION = "发货要多久";

/** gold 文档级/ chunk 级引用（F3 结构）。 */
const GOLD_DOC_ID = randomUUID();
const GOLD_CHUNK_ID = randomUUID();

describeInfra("E-W2b 功能波（HTTP e2e，真 PG + 真 ClickHouse）", () => {
  let app: INestApplication;
  let harness: Awaited<ReturnType<typeof createEvaluationInfraHarness>>;
  let evalRunsRepo: EvalRunsRepository;
  let evalSetsRepo: EvalSetsRepository;
  let evaluationsRepo: EvaluationsRepository;
  let clickhouse: ClickHouseEvaluationsRepository;
  const previewTraceIds: string[] = [];
  const onlineTraceId = hex32();

  const applications = {
    resolveForTest: jest.fn(async () => ({
      applicationId: APP_ID,
      configVersionId: CONFIG_VERSION_ID,
      version: 7,
      preview: true,
    })),
    listVersions: jest.fn(async () => [{ id: CONFIG_VERSION_ID, version: 7 }]),
  };
  const queue = { publish: jest.fn(), subscribe: jest.fn(), schedule: jest.fn() };

  beforeAll(async () => {
    harness = await createEvaluationInfraHarness();
    await harness.resetAndMigrate();
    evalRunsRepo = new EvalRunsRepository(harness.db as never);
    evalSetsRepo = new EvalSetsRepository(harness.db as never);
    evaluationsRepo = new EvaluationsRepository(harness.db as never);
    clickhouse = new ClickHouseEvaluationsRepository(harness.clickhouse as never);

    const setsService = new EvalSetsService(evalSetsRepo);
    const runsService = new EvalRunsService(
      evalRunsRepo,
      evalSetsRepo,
      applications as never,
      queue as never,
    );

    const ref = await Test.createTestingModule({
      controllers: [EvalSetsController, EvalRunsController],
      providers: [
        { provide: EvalSetsService, useValue: setsService },
        { provide: EvalRunsService, useValue: runsService },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        {
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

    await insertOnlineEvalSpan(onlineTraceId);
  });

  afterEach(async () => {
    // run 全局串行 → 每条用例后清空，否则残留 run 把后续 POST 连坐成 409。
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

  /** 一条在线 rag.eval span（隔离回归的基线，让 overview 样本数非 0）。 */
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
        "rag.eval.version": "online-v1",
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
    return res.body.id as string;
  }

  async function review(setId: string, caseId: string): Promise<void> {
    await http()
      .patch(`/api/eval/sets/${setId}/cases/${caseId}`)
      .send({ status: "reviewed" })
      .expect(200);
  }

  /** F3：给一个已审核用例的 v1 版本行直接种 gold_doc_refs（chunk 级）。 */
  async function seedGoldRefs(
    caseId: string,
    refs: Array<{ docId: string; chunkId: string | null; docName: string; section: string | null }>,
  ): Promise<void> {
    await harness.pool.query(
      `UPDATE eval_case_versions SET gold_doc_refs = $1::jsonb WHERE case_id = $2 AND version = 1`,
      [JSON.stringify(refs), caseId],
    );
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

  // ─────────────────────────────── worker 装配 ───────────────────────────────

  interface WorkerOptions {
    /** 每条用例的编排调用结束后触发（停止测试用它在跑到第 N 个 unit 时发停止信号）。 */
    onCase?: (callIndex: number) => Promise<void>;
    /**
     * 编排返回的检索命中（F2）——按 rank 序。默认给一条与 gold 精确匹配的 chunk 命中，
     * 让「有 gold 的用例」召回三项打满；无 gold 的用例三项由 goldDocRefs=[] 自然 NULL。
     */
    retrievedHits?: Array<{ chunkId: string; docId: string }>;
  }

  /** 真 worker + 真 PG 仓库；只桩编排与裁判。F2 新字段（retrievedHits/retrievalExecuted）如实透出。 */
  function makeWorker(options: WorkerOptions = {}) {
    let calls = 0;
    const orchestration = {
      runForEvaluation: jest.fn(async (_cfg: unknown, question: string) => {
        const traceId = hex32();
        previewTraceIds.push(traceId);
        calls += 1;
        await options.onCase?.(calls);
        return {
          traceId,
          replyText: `答：${question}`,
          hits: [{ chunkId: GOLD_CHUNK_ID, text: "退款政策……", finalScore: 0.9 }],
          // F2：阈值判定前的合并命中，带 docId；worker 据此算 gold 检索指标。
          retrievedHits: options.retrievedHits ?? [{ chunkId: GOLD_CHUNK_ID, docId: GOLD_DOC_ID }],
          retrievalExecuted: true,
          usage: ORCHESTRATION_USAGE,
          isFallback: false,
          timedOut: false,
        };
      }),
    };
    const judge = {
      scoreOffline: jest.fn(async () => ({
        faithfulness: 92,
        answerRelevancy: 88,
        contextPrecision: 84,
        correctness: 90,
        citation: 86, // F4：仅记分卡，不进 verdict
        evidence: { faithfulness: ["有据可依"], citation: ["[supported] 结论有支撑"] },
        usage: JUDGE_USAGE,
      })),
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

  async function seedReviewedSet(name: string, questions: string[]): Promise<string> {
    const setId = await createSet(name);
    for (const question of questions) {
      const caseId = await addCase(setId, question, [`${question}的 gold 要点`]);
      await review(setId, caseId);
    }
    return setId;
  }

  // ══════════════════════════ F5 每题重复（AC5-1 / AC5-3） ══════════════════════════

  it("AC5-1 repeat=3 × 2 用例 → 6 行结果、报告 2 聚合行各带 3 明细、进度 6/6", async () => {
    const setId = await seedReviewedSet("每题重复集", [GOOD_QUESTION, SECOND_QUESTION]);
    const runId = (await startRun(setId, { repeatCount: 3 }).expect(201)).body.id as string;

    const { processor } = makeWorker();
    expect((await processor.processRun(runId)).status).toBe("done");

    // 存储层：6 个 unit 行（2 用例 × 3 重复），唯一索引含 repeat_index 才不撞。
    const rows = await harness.pool.query(
      "SELECT count(*)::int AS n FROM eval_run_results WHERE run_id = $1",
      [runId],
    );
    expect(rows.rows[0].n).toBe(6);

    const report = (await http().get(`/api/eval/runs/${runId}`).expect(200)).body;
    // 进度 6/(2×3)：doneCases=unit 数、totalCases=用例数、repeatCount=3。
    expect(report.run).toMatchObject({
      status: "done",
      doneCases: 6,
      totalCases: 2,
      repeatCount: 3,
    });
    // 报告聚合为每用例一行，各带 3 条重复明细。
    expect(report.results).toHaveLength(2);
    for (const row of report.results) {
      expect(row.repeatCount).toBe(3);
      expect(row.repeats).toHaveLength(3);
      expect(row.repeats.map((r: { repeatIndex: number }) => r.repeatIndex)).toEqual([1, 2, 3]);
      // 等权重复取均值 → 聚合值 == 单次值（判分桩恒定）。
      expect(row.faithfulness).toBe(92);
      expect(row.verdict).toBe("pass");
    }
    expect(report.skipped).toEqual([]);
  });

  it("AC5-3 中途停止（4/6 unit）→ partial；第 2 用例按 1 次重复聚合，不算 skipped", async () => {
    const setId = await seedReviewedSet("重复停止集", [GOOD_QUESTION, SECOND_QUESTION]);
    const runId = (await startRun(setId, { repeatCount: 3 }).expect(201)).body.id as string;

    // 第 4 个 unit（= 用例2 的第 1 次重复）跑完后发停止 → 第 5 个 unit 开跑前命中 → partial。
    const { processor } = makeWorker({
      onCase: async (index) => {
        if (index === 4) await http().post(`/api/eval/runs/${runId}/stop`).expect(204);
      },
    });
    expect((await processor.processRun(runId)).status).toBe("partial");

    const report = (await http().get(`/api/eval/runs/${runId}`).expect(200)).body;
    expect(report.run).toMatchObject({ status: "partial", doneCases: 4, totalCases: 2 });
    // 两个用例都有 ≥1 行结果 → 都不算 skipped（AC5-3 关键点）。
    expect(report.results).toHaveLength(2);
    expect(report.skipped).toEqual([]);
    const byQuestion = new Map<string, { repeats: unknown[] }>(
      report.results.map((r: { question: string }) => [r.question, r]),
    );
    expect(byQuestion.get(GOOD_QUESTION)!.repeats).toHaveLength(3);
    expect(byQuestion.get(SECOND_QUESTION)!.repeats).toHaveLength(1); // 只跑了 1 次即被停
  });

  // ══════════════════════════ F2 gold 检索指标（AC2-2） ══════════════════════════

  it("AC2-2 带 goldDocRefs 的用例三列非空且 0-100；无 gold 用例三列 NULL；记分卡覆盖率正确", async () => {
    const setId = await createSet("gold 指标集");
    const goldCaseId = await addCase(setId, GOOD_QUESTION, ["7 天内无理由退"]);
    const noGoldCaseId = await addCase(setId, SECOND_QUESTION, ["3-5 个工作日"]);
    await review(setId, goldCaseId);
    await review(setId, noGoldCaseId);
    // 只给第一个用例种 chunk 级 gold（第二个 goldDocRefs 保持 []）。
    await seedGoldRefs(goldCaseId, [
      { docId: GOLD_DOC_ID, chunkId: GOLD_CHUNK_ID, docName: "退款政策", section: "§2" },
    ]);

    const runId = (await startRun(setId).expect(201)).body.id as string;
    const { processor } = makeWorker(); // 默认命中 = 与 gold 精确匹配的 chunk
    expect((await processor.processRun(runId)).status).toBe("done");

    const report = (await http().get(`/api/eval/runs/${runId}`).expect(200)).body;
    const byQuestion = new Map<string, Record<string, number | null>>(
      report.results.map((r: { question: string }) => [r.question, r]),
    );

    // ① 有 gold + 命中匹配 → 三列打满（chunk 精确命中 top1）。
    const gold = byQuestion.get(GOOD_QUESTION)!;
    expect(gold.contextRecall).toBe(100);
    expect(gold.ndcg5).toBe(100);
    expect(gold.hitRate5).toBe(100);

    // ② 无 gold 用例 → 三列 NULL，**绝不是 0**（不变量 2）。
    const noGold = byQuestion.get(SECOND_QUESTION)!;
    expect(noGold.contextRecall).toBeNull();
    expect(noGold.ndcg5).toBeNull();
    expect(noGold.hitRate5).toBeNull();

    // ③ 记分卡：检索层三项 avg 只含已评样本 + goldCoverage（本 run 快照 1/2 已标）。
    expect(report.scorecard.retrieval).toMatchObject({
      contextRecall: { value: 100, scoredCount: 1, total: 2 },
      ndcg5: { value: 100, scoredCount: 1, total: 2 },
      hitRate5: { value: 100, scoredCount: 1, total: 2 },
      goldCoverage: { withGold: 1, total: 2 },
    });
    // ④ citation（F4）落记分卡但不进 verdict。
    expect(report.scorecard.generation.citation).toMatchObject({ value: 86, scoredCount: 2 });
  });

  // ══════════════════════════ F8 屏4 对比（AC8-1 / AC8-2） ══════════════════════════

  it("AC8-1 同集同题两 run → GET /eval/runs/compare 全表 Δ 正确；|Δ|<3 significant=false", async () => {
    const setId = await seedReviewedSet("对比集", [GOOD_QUESTION, SECOND_QUESTION]);

    const runAId = (await startRun(setId).expect(201)).body.id as string;
    expect((await makeWorker().processor.processRun(runAId)).status).toBe("done");
    // 1h 幂等 → force 强跑第二个 run（同集同版本）。
    const runBId = (await startRun(setId, { force: true }).expect(201)).body.id as string;
    expect((await makeWorker().processor.processRun(runBId)).status).toBe("done");

    const res = await http()
      .get("/api/eval/runs/compare")
      .query({ a: runAId, b: runBId })
      .expect(200);
    const body = res.body;

    // 8 指标行齐全。
    expect(body.metrics.map((m: { key: string }) => m.key)).toEqual([
      "faithfulness",
      "answerRelevancy",
      "contextPrecision",
      "correctness",
      "citation",
      "contextRecall",
      "ndcg5",
      "hitRate5",
    ]);
    // 判分桩恒定 → 两 run 逐指标相等 → delta=0；|Δ|<3 → significant=false（不给箭头）。
    const faith = body.metrics.find((m: { key: string }) => m.key === "faithfulness");
    expect(faith).toMatchObject({ a: 92, b: 92, delta: 0, significant: false });
    expect(body.summary).toMatchObject({
      overallDelta: 0,
      regressedCount: 0,
      improvedCount: 0,
      judgeMismatch: false,
    });
  });

  it("AC8-2 题库集合不一致 → 409 body {code:'incomparable'}", async () => {
    const setA = await seedReviewedSet("对比集A", [GOOD_QUESTION]);
    const runAId = (await startRun(setA).expect(201)).body.id as string;
    expect((await makeWorker().processor.processRun(runAId)).status).toBe("done");

    const setB = await seedReviewedSet("对比集B", [SECOND_QUESTION]);
    const runBId = (await startRun(setB).expect(201)).body.id as string;
    expect((await makeWorker().processor.processRun(runBId)).status).toBe("done");

    const res = await http()
      .get("/api/eval/runs/compare")
      .query({ a: runAId, b: runBId })
      .expect(409);
    expect(res.body).toEqual({ code: "incomparable" });
  });

  // ══════════════════ F7 重放隔离（AC7-1 / AC7-2 / AC7-3 / AC7-4） ══════════════════
  //
  // 沿 `eval-run-isolation.spec.ts` 模式：直接驱动 ReplayService（不过 SSE controller），
  // 桩编排 runForReplay（逐帧转发 + 写一条 preview rag.pipeline span），断言隔离靠**存储物理
  // 分离**——重放不落 eval_results、不发 rag.eval span、不进屏1 overview、不落会话。

  const REPLAY_WINDOW = { from: FROM, to: TO, judgeVersion: "online-v1" };

  interface ReplayOrchestrationOptions {
    hits?: Array<{ chunkId: string; text: string; finalScore: number }>;
    error?: boolean;
  }

  /** 桩 runForReplay：onPrep 回捕 hits → 逐 token → 写 preview span → done。 */
  function makeReplayOrchestration(options: ReplayOrchestrationOptions = {}) {
    return {
      runForReplay: jest.fn((_cfg: unknown, question: string, opts: { onPrep?: (p: unknown) => void }) => {
        async function* gen(): AsyncGenerator<Record<string, unknown>> {
          opts.onPrep?.({ hits: options.hits ?? [] });
          const traceId = hex32();
          previewTraceIds.push(traceId);
          await harness.insertSpan({
            traceId,
            spanId: hex16(),
            at: SPAN_AT,
            name: "rag.pipeline",
            attributes: {
              "codecrush.span.kind": "chain",
              "rag.preview": "true", // preview 标记救不了 overview（见隔离证据），但重放本就不发 rag.eval
              "gen_ai.agent.id": AGENT_ID,
              "codecrush.io.input": question,
            },
          });
          if (options.error) {
            yield { type: "error", message: "生成失败" };
            return;
          }
          yield { type: "token", delta: "七天内" };
          yield { type: "token", delta: "可退款" };
          yield {
            type: "done",
            traceId,
            coverage: "full",
            isFallback: false,
            fallbackReasons: [],
          };
        }
        return gen();
      }),
    };
  }

  const replayApplications = {
    resolveForTest: jest.fn(async () => ({
      applicationId: APP_ID,
      configVersionId: CONFIG_VERSION_ID,
      version: 7,
      preview: true,
    })),
  };

  function makeReplayService(orchestration: unknown, judge: unknown) {
    return new ReplayService(
      orchestration as never,
      replayApplications as never,
      judge as never,
      evaluationsRepo,
    );
  }

  async function drainReplay(
    service: ReplayService,
    sourceTraceId: string,
  ): Promise<Array<{ type: string } & Record<string, unknown>>> {
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    for await (const ev of service.stream(
      {
        applicationId: APP_ID,
        configVersionId: CONFIG_VERSION_ID,
        question: GOOD_QUESTION,
        sourceTraceId,
      },
      ACTOR,
    )) {
      events.push(ev as { type: string } & Record<string, unknown>);
    }
    return events;
  }

  it("AC7-1 重放不污染屏1 / 不落会话 / 不发 rag.eval span（隔离守护网）", async () => {
    // 裁判未配置（默认设置 judge/embedding 为 NULL）→ 不判分、不追发 replay_scores。
    const overviewBefore = await clickhouse.getOverview(REPLAY_WINDOW);
    expect(overviewBefore.sampleCount).toBeGreaterThan(0);
    const convBefore = await harness.pool.query("SELECT count(*)::int AS n FROM conversations");
    const evalSpansBefore = await countEvalSpans();

    const judge = { scoreOffline: jest.fn() };
    const service = makeReplayService(makeReplayOrchestration(), judge);
    const events = await drainReplay(service, hex32());

    // SSE 逐 token + done（带 preview traceId），无 replay_scores（裁判未配置）。
    expect(events.filter((e) => e.type === "token")).toHaveLength(2);
    const done = events.find((e) => e.type === "done")!;
    expect(done.traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(events.some((e) => e.type === "replay_scores")).toBe(false);
    expect(judge.scoreOffline).not.toHaveBeenCalled();

    // 隔离：overview 样本数与三指标一点不变；无新 rag.eval span；无会话行；无 eval_run_results。
    const overviewAfter = await clickhouse.getOverview(REPLAY_WINDOW);
    expect(overviewAfter.sampleCount).toBe(overviewBefore.sampleCount);
    expect(overviewAfter.faithfulness).toBe(overviewBefore.faithfulness);
    expect(await countEvalSpans()).toBe(evalSpansBefore);
    const convAfter = await harness.pool.query("SELECT count(*)::int AS n FROM conversations");
    expect(convAfter.rows[0].n).toBe(convBefore.rows[0].n);
    const results = await harness.pool.query("SELECT count(*)::int AS n FROM eval_run_results");
    expect(results.rows[0].n).toBe(0);
  });

  it("AC7-2 限频：60s 内同 sourceTraceId 第二次重放 → 429 文案逐字", async () => {
    const judge = { scoreOffline: jest.fn() };
    const service = makeReplayService(makeReplayOrchestration(), judge);
    const sourceTraceId = hex32();
    await drainReplay(service, sourceTraceId); // 第一次正常

    const err = await drainReplay(service, sourceTraceId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).message).toBe("操作过于频繁，请 1 分钟后再试");
  });

  it("AC7-4 版本停用/不存在 → 422「该版本已不可用」", async () => {
    const judge = { scoreOffline: jest.fn() };
    const service = new ReplayService(
      makeReplayOrchestration() as never,
      { resolveForTest: jest.fn(async () => { throw new Error("版本不存在"); }) } as never,
      judge as never,
      evaluationsRepo,
    );
    const err = await drainReplay(service, hex32()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(422);
    expect((err as HttpException).message).toBe("该版本已不可用");
  });

  it("AC7-3 裁判已配置 → 流末尾追发 replay_scores 帧；分数仍不落库", async () => {
    // 配置在线设置的裁判/embedding（重放判分复用在线设置的模型，与 enabled 开关无关）。
    await harness.pool.query(
      `UPDATE online_eval_settings SET judge_model_id=$1, embedding_model_id=$2 WHERE id='default'`,
      [E2E_JUDGE_MODEL_ID, E2E_EMBED_MODEL_ID],
    );
    const resultsBefore = await harness.pool.query(
      "SELECT count(*)::int AS n FROM eval_run_results",
    );

    const judge = {
      scoreOffline: jest.fn(async () => ({
        faithfulness: 91,
        answerRelevancy: 87,
        contextPrecision: 83,
        correctness: null,
        citation: null,
        evidence: { faithfulness: ["有支撑"] },
        usage: JUDGE_USAGE,
      })),
    };
    const service = makeReplayService(
      makeReplayOrchestration({ hits: [{ chunkId: GOLD_CHUNK_ID, text: "退款政策", finalScore: 0.9 }] }),
      judge,
    );
    const events = await drainReplay(service, hex32());

    const scores = events.find((e) => e.type === "replay_scores");
    expect(scores).toMatchObject({
      faithfulness: 91,
      answerRelevancy: 87,
      contextPrecision: 83,
    });
    expect(judge.scoreOffline).toHaveBeenCalledTimes(1);
    // 分数只走 SSE，不落任何存储（不变量 1）。
    const resultsAfter = await harness.pool.query(
      "SELECT count(*)::int AS n FROM eval_run_results",
    );
    expect(resultsAfter.rows[0].n).toBe(resultsBefore.rows[0].n);

    // 复位设置，免得连坐后续用例（afterEach 不碰 online_eval_settings）。
    await harness.pool.query(
      `UPDATE online_eval_settings SET judge_model_id=NULL, embedding_model_id=NULL WHERE id='default'`,
    );
  });

  // ─────────────────────────────── ClickHouse 读工具 ───────────────────────────────

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
});
