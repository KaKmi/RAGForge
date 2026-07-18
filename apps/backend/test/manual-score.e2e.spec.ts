import { APP_PIPE } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { ZodValidationPipe } from "nestjs-zod";
import request from "supertest";
import { applyGlobalConfig } from "../src/app/app-bootstrap";
import { ChunksRepository } from "../src/modules/chunks/chunks.repository";
import { ChunksService } from "../src/modules/chunks/chunks.service";
import { ConversationsRepository } from "../src/modules/conversations/conversations.repository";
import { ConversationsService } from "../src/modules/conversations/conversations.service";
import { DocumentsRepository } from "../src/modules/documents/documents.repository";
import { AnswerRelevancyEvaluator } from "../src/modules/evaluations/answer-relevancy.evaluator";
import { ClickHouseEvaluationsRepository } from "../src/modules/evaluations/clickhouse-evaluations.repository";
import { ContextPrecisionEvaluator } from "../src/modules/evaluations/context-precision.evaluator";
import { EvaluationInputService } from "../src/modules/evaluations/evaluation-input.service";
import { EvaluationJudgeService } from "../src/modules/evaluations/evaluation-judge.service";
import { EvaluationsController } from "../src/modules/evaluations/evaluations.controller";
import { EvaluationsRepository } from "../src/modules/evaluations/evaluations.repository";
import { EvaluationsService } from "../src/modules/evaluations/evaluations.service";
import { FaithfulnessEvaluator } from "../src/modules/evaluations/faithfulness.evaluator";
import { ManualScoreProcessor } from "../src/modules/evaluations/manual-score.processor";
import {
  createEvaluationInfraHarness,
  E2E_EMBED_MODEL_ID,
  E2E_JUDGE_MODEL_ID,
  type EvaluationInfraHarness,
} from "./helpers/evaluation-infra";
import { infraGate } from "./helpers/gated-suite";

const describeInfra = infraGate();
jest.setTimeout(180_000);

/**
 * B1/F3「立即评测」的端到端钉。
 *
 * 最关键的两条不是「功能能用」，而是**不变量**：
 *  1. 人工评测**不写** `eval_candidate_ledger`、**不动** `eval_watermarks` 三列；
 *  2. 发出的 `rag.eval` span 带 `rag.eval.trigger = "manual"`。
 * 其余（已评直接返回、60s 限频、worker 后续走 already_scored）同样在此钉住。
 */
describeInfra("B1/F3 立即评测（真 PG + 真 ClickHouse）", () => {
  let harness: EvaluationInfraHarness;
  let app: INestApplication;
  let repo: EvaluationsRepository;
  let clickhouse: ClickHouseEvaluationsRepository;
  let processor: ManualScoreProcessor;
  let service: EvaluationsService;
  let judgeSpy: jest.SpyInstance;

  const targetTraceId = "b1f30000000000000000000000000001";
  const evalSpanTraceId = "b1f30000000000000000000000000002";
  const agentId = "b1f3-agent";
  const WORKER = "online-quality-v1";
  const publishedJobs: Array<{ targetTraceId: string; judgeVersion: string }> = [];

  const fakeModels = {
    get: jest.fn(async (id: string) => ({
      id,
      type: id === E2E_EMBED_MODEL_ID ? "embedding" : "llm",
      enabled: true,
      name: "fake",
      protocol: "openai_compat",
      baseUrl: "http://unused",
      params: {},
    })),
    list: jest.fn(async () => []),
  };

  /** 队列桩：只记录 publish，消费由测试显式触发（drainManualQueue）。 */
  const queue = {
    publish: jest.fn(async (_job: string, data: unknown) => {
      publishedJobs.push(data as { targetTraceId: string; judgeVersion: string });
    }),
    subscribe: jest.fn(async () => undefined),
    schedule: jest.fn(async () => undefined),
  };

  async function drainManualQueue(): Promise<void> {
    while (publishedJobs.length > 0) {
      const job = publishedJobs.shift()!;
      await processor.process(job.targetTraceId, job.judgeVersion);
    }
  }

  async function seedTrace(traceId: string): Promise<void> {
    await harness.seedPgInput(traceId, agentId);
    await harness.insertSpan({
      traceId,
      spanId: traceId.slice(0, 16),
      at: "2026-07-15T01:30:00.000Z",
      name: "rag.chain",
      attributes: {
        "rag.node.name": "reply",
        "gen_ai.agent.id": agentId,
        "gen_ai.request.model": "generation-1",
        "codecrush.io.input": "怎么退款",
        "codecrush.io.output": "7 天内无理由",
      },
    });
  }

  beforeAll(async () => {
    harness = await createEvaluationInfraHarness();
    await harness.resetAndMigrate();
    repo = new EvaluationsRepository(harness.db as never);
    clickhouse = new ClickHouseEvaluationsRepository(harness.clickhouse);
    const input = new EvaluationInputService(
      new ConversationsService(new ConversationsRepository(harness.db as never)),
      new ChunksService(
        new ChunksRepository(harness.db as never),
        new DocumentsRepository(harness.db as never),
      ),
    );
    const judge = new EvaluationJudgeService(
      new FaithfulnessEvaluator(fakeModels as never),
      new AnswerRelevancyEvaluator(fakeModels as never),
      new ContextPrecisionEvaluator(fakeModels as never),
    );
    judgeSpy = jest.spyOn(judge, "score");

    // emitter 落真 span 到 ClickHouse，才能验 trigger 属性与 findExisting 去重。
    const emitter = {
      emitSuccess: jest.fn(
        async (payload: {
          candidate: { agentId: string; generationModel: string };
          input: { targetTraceId: string };
          settings: { judgeModelId: string; judgeVersion: string; trigger?: string };
          result: { faithfulness: number | null; answerRelevancy: number; contextPrecision: number };
        }) => {
          await harness.insertSpan({
            traceId: evalSpanTraceId,
            spanId: evalSpanTraceId.slice(0, 16),
            at: "2026-07-15T01:45:00.000Z",
            name: "rag.eval",
            attributes: {
              "rag.eval.target_trace_id": payload.input.targetTraceId,
              "rag.eval.version": payload.settings.judgeVersion,
              "rag.eval.status": "success",
              "rag.eval.judge_model": payload.settings.judgeModelId,
              // 被测对象：默认 worker，人工路径必须是 manual
              "rag.eval.trigger": payload.settings.trigger ?? "worker",
              "rag.eval.answer_relevancy": String(payload.result.answerRelevancy),
              "rag.eval.context_precision": String(payload.result.contextPrecision),
              "gen_ai.agent.id": payload.candidate.agentId,
              "gen_ai.request.model": payload.candidate.generationModel,
            },
          });
        },
      ),
      emitFailure: jest.fn(),
    };

    processor = new ManualScoreProcessor(
      queue as never,
      repo,
      clickhouse,
      input,
      judge,
      emitter as never,
    );
    service = new EvaluationsService(repo, clickhouse, fakeModels as never, queue as never);

    const ref = await Test.createTestingModule({
      controllers: [EvaluationsController],
      providers: [
        { provide: EvaluationsService, useValue: service },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
      ],
    }).compile();
    app = ref.createNestApplication();
    // 端点读 req.user.email 记 requestedBy；测试里没有真实鉴权，注入一个假身份。
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { email: "t@example.com" };
      next();
    });
    applyGlobalConfig(app);
    await app.init();
  });

  beforeEach(async () => {
    publishedJobs.length = 0;
    judgeSpy.mockClear();
    // 限频是进程内 Map，跨用例必须清，否则第二条用例起全是 429。
    (service as unknown as { lastManualScoreAt: Map<string, number> }).lastManualScoreAt.clear();
    await repo.updateSettings({
      enabled: true,
      judgeModelId: E2E_JUDGE_MODEL_ID,
      embeddingModelId: E2E_EMBED_MODEL_ID,
    });
    await repo.getOrCreateWatermark(WORKER, new Date("2026-07-15T02:00:00.000Z"));
    await harness.pool.query("DELETE FROM eval_manual_score_jobs");
    await harness.pool.query("DELETE FROM eval_candidate_ledger");
    await seedTrace(targetTraceId);
  });

  afterEach(async () => {
    await harness.cleanup([targetTraceId, evalSpanTraceId]);
  });

  afterAll(async () => {
    await app.close();
    await harness.close();
  });

  const post = (traceId: string) =>
    request(app.getHttpServer()).post(`/api/eval/quality/traces/${traceId}/score`);

  it("对未评 trace 返回 scoring 并建 job 行（queued）", async () => {
    const res = await post(targetTraceId).expect(201);
    expect(res.body).toEqual({ status: "scoring" });
    const { rows } = await harness.pool.query(
      `SELECT status, requested_by FROM eval_manual_score_jobs WHERE target_trace_id = $1`,
      [targetTraceId],
    );
    expect(rows[0]).toMatchObject({ status: "queued", requested_by: "t@example.com" });
  });

  /** 【本波最关键的一钉】人工评测不进游标/账本体系。 */
  it("【不变量】不写账本、不动水位线三列", async () => {
    const before = await harness.pool.query(
      `SELECT last_ts, last_trace_id, daily_count FROM eval_watermarks WHERE worker_name = $1`,
      [WORKER],
    );
    await post(targetTraceId).expect(201);
    await drainManualQueue();

    const after = await harness.pool.query(
      `SELECT last_ts, last_trace_id, daily_count FROM eval_watermarks WHERE worker_name = $1`,
      [WORKER],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);

    const ledger = await harness.pool.query(
      `SELECT count(*)::int AS n FROM eval_candidate_ledger`,
    );
    expect(ledger.rows[0].n).toBe(0);
  });

  it("处理完成后 ClickHouse 有 rag.eval span 且 trigger=manual", async () => {
    await post(targetTraceId).expect(201);
    await drainManualQueue();

    const result = await harness.clickhouse.query({
      query: `SELECT SpanAttributes['rag.eval.trigger'] AS trigger
              FROM otel_traces
              WHERE SpanName = 'rag.eval'
                AND SpanAttributes['rag.eval.target_trace_id'] = {t:String}`,
      query_params: { t: targetTraceId },
      format: "JSONEachRow",
    });
    const rows = await result.json<{ trigger: string }>();
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger).toBe("manual");

    const job = await harness.pool.query(
      `SELECT status FROM eval_manual_score_jobs WHERE target_trace_id = $1`,
      [targetTraceId],
    );
    expect(job.rows[0].status).toBe("scored");
  });

  it("已评过的 trace 再次 POST 直接返回 scored，不入队不计费", async () => {
    await post(targetTraceId).expect(201);
    await drainManualQueue();
    judgeSpy.mockClear();
    (service as unknown as { lastManualScoreAt: Map<string, number> }).lastManualScoreAt.clear();

    const res = await post(targetTraceId).expect(201);
    expect(res.body).toEqual({ status: "scored" });
    expect(publishedJobs).toHaveLength(0);
    expect(judgeSpy).not.toHaveBeenCalled();
  });

  it("同一 trace 60s 内第二次 POST → 429", async () => {
    await post(targetTraceId).expect(201);
    await post(targetTraceId).expect(429);
  });

  it("评分中时 GET 质量详情返回 scoring 态（面板轮询的数据源）", async () => {
    await post(targetTraceId).expect(201);
    const res = await request(app.getHttpServer())
      .get(`/api/eval/quality/traces/${targetTraceId}`)
      .expect(200);
    expect(res.body.status).toBe("scoring");
    expect(typeof res.body.startedAt).toBe("string");
  });

  it("在线评测未启用时 422（不建 job、不入队）", async () => {
    await repo.updateSettings({ enabled: false });
    await post(targetTraceId).expect(422);
    expect(publishedJobs).toHaveLength(0);
    const { rows } = await harness.pool.query(
      `SELECT count(*)::int AS n FROM eval_manual_score_jobs WHERE target_trace_id = $1`,
      [targetTraceId],
    );
    expect(rows[0].n).toBe(0);
  });

  it("非法 traceId → 400", async () => {
    await request(app.getHttpServer()).post(`/api/eval/quality/traces/not-hex/score`).expect(400);
  });
});
