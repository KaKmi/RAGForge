import { BadRequestException, type INestApplication } from "@nestjs/common";
import { APP_PIPE } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { TraceQualityDetail } from "@codecrush/contracts";
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
import { EvaluationWorkerProcessor } from "../src/modules/evaluations/evaluation-worker.processor";
import { EvaluationsController } from "../src/modules/evaluations/evaluations.controller";
import { EvaluationsService } from "../src/modules/evaluations/evaluations.service";
import { EvaluationsRepository } from "../src/modules/evaluations/evaluations.repository";
import { FaithfulnessEvaluator } from "../src/modules/evaluations/faithfulness.evaluator";
import { evalDedupeKey } from "../src/modules/evaluations/sampling";
import { ClickHouseTracesRepository } from "../src/modules/traces/clickhouse-traces.repository";
import { TracesController } from "../src/modules/traces/traces.controller";
import { TracesService } from "../src/modules/traces/traces.service";
import {
  createEvaluationInfraHarness,
  E2E_EMBED_MODEL_ID,
  E2E_JUDGE_MODEL_ID,
} from "./helpers/evaluation-infra";

describe("EvaluationsService", () => {
  const settings = {
    id: "default",
    enabled: false,
    sampleRate: 0.1,
    judgeModelId: null,
    embeddingModelId: null,
    faithfulnessThreshold: 85,
    answerRelevancyThreshold: 80,
    contextPrecisionThreshold: 80,
    dailyCap: 500,
    judgeVersion: "online-v1",
    updatedAt: new Date("2026-07-15T02:00:00.000Z"),
  };

  function setup() {
    const control = {
      getSettings: jest.fn().mockResolvedValue(settings),
      updateSettings: jest.fn().mockResolvedValue(settings),
      getOrCreateWatermark: jest.fn().mockResolvedValue({
        lastTs: new Date("2026-07-15T01:55:00.000Z"),
        dailyCount: 0,
      }),
    };
    const clickhouse = {
      getOverview: jest.fn().mockResolvedValue({
        sampleCount: 0,
        faithfulness: null,
        answerRelevancy: null,
        contextPrecision: null,
      }),
      getMinuteAggregates: jest.fn().mockResolvedValue([]),
      getByAgent: jest.fn().mockResolvedValue([]),
      getLowSamples: jest.fn().mockResolvedValue([]),
      countEligible: jest.fn().mockResolvedValue(0),
      countBacklog: jest.fn().mockResolvedValue(0),
      getLatestSuccess: jest.fn().mockResolvedValue(undefined),
      getLatestFailure: jest.fn().mockResolvedValue(undefined),
    };
    const models = { get: jest.fn(), list: jest.fn().mockResolvedValue([]) };
    const service = new EvaluationsService(control as never, clickhouse as never, models as never);
    return { service, control, clickhouse, models };
  }

  it("rejects enabling settings with a disabled or wrong-type model", async () => {
    const { service, models } = setup();
    models.get.mockResolvedValueOnce({ id: "m1", type: "embedding", enabled: true });
    await expect(
      service.updateSettings({ enabled: true, judgeModelId: "m1", embeddingModelId: "m2" }),
    ).rejects.toThrow(new BadRequestException("judgeModelId must reference an enabled llm model"));
  });

  it("returns the newest successful version before considering a later failure", async () => {
    const { service, clickhouse } = setup();
    clickhouse.getLatestSuccess.mockResolvedValue({
      targetTraceId: "a".repeat(32),
      judgeVersion: "online-v2",
      evaluatedAt: "2026-07-15T02:00:00.000Z",
      judgeModel: "judge-1",
      faithfulness: 90,
      answerRelevancy: 80,
      contextPrecision: 70,
      evidence: JSON.stringify({
        faithfulness: ["grounded"],
        answerRelevancy: ["relevant"],
        contextPrecision: ["one noisy chunk"],
      }),
    });
    clickhouse.getLatestFailure.mockResolvedValue({
      judgeVersion: "online-v1",
      failedAt: "2026-07-15T03:00:00.000Z",
      reason: "JudgeUnavailable: down",
    });

    await expect(service.getTraceQuality("a".repeat(32))).resolves.toMatchObject({
      status: "scored",
      judgeVersion: "online-v2",
      scores: { faithfulness: 90 },
      currentVersion: false,
    });
    expect(clickhouse.getLatestFailure).not.toHaveBeenCalled();
  });

  it("suppresses previous deltas below twenty samples", async () => {
    const { service, clickhouse } = setup();
    clickhouse.getOverview
      .mockResolvedValueOnce({
        sampleCount: 19,
        faithfulness: 90,
        answerRelevancy: 85,
        contextPrecision: 80,
      })
      .mockResolvedValueOnce({
        sampleCount: 100,
        faithfulness: 80,
        answerRelevancy: 80,
        contextPrecision: 80,
      });
    const result = await service.getOverview({}, new Date("2026-07-15T02:00:00.000Z"));
    expect(result.metrics.faithfulness).toMatchObject({ value: 90, previousDelta: null });
  });

  it("does not label fully passing rows as low samples", async () => {
    const { service, clickhouse } = setup();
    clickhouse.getLowSamples.mockResolvedValue([
      {
        targetTraceId: "b".repeat(32),
        question: "high quality answer",
        faithfulness: 100,
        answerRelevancy: 100,
        contextPrecision: 100,
        evidence: "{}",
      },
    ]);

    const result = await service.getOverview({}, new Date("2026-07-15T02:00:00.000Z"));
    expect(result.lowSamples).toEqual([]);
  });

  it("maps a zero-sample agent to null scores even if ClickHouse supplies zero defaults", async () => {
    const { service, clickhouse } = setup();
    clickhouse.getByAgent.mockResolvedValue([
      {
        agentId: "agent-empty",
        agentName: "Empty Agent",
        sampleCount: 0,
        faithfulness: 0,
        answerRelevancy: 0,
        contextPrecision: 0,
      },
    ]);
    const result = await service.getOverview({}, new Date("2026-07-15T02:00:00.000Z"));
    expect(result.byAgent).toEqual([
      { agentId: "agent-empty", agentName: "Empty Agent", sampleCount: 0, scores: null },
    ]);
  });
});

const infraEnabled =
  process.env.RUN_DB_TESTS === "1" &&
  process.env.RUN_CLICKHOUSE_TESTS === "1" &&
  Boolean(process.env.MIGRATION_TEST_DATABASE_URL);
const describeInfra = infraEnabled ? describe : describe.skip;

describeInfra("E-W1 infrastructure flow", () => {
  let app: INestApplication;
  let harness: Awaited<ReturnType<typeof createEvaluationInfraHarness>>;
  let evaluationsRepo: EvaluationsRepository;
  let clickhouseEvaluations: ClickHouseEvaluationsRepository;
  let processor: EvaluationWorkerProcessor;
  let service: EvaluationsService;
  let traces: TracesService;

  const fixedNow = new Date("2026-07-15T02:00:00.000Z");
  const targetTraceId = "a".repeat(32);
  const previewTraceId = "b".repeat(32);
  const from = "2026-07-15T01:00:00.000Z";
  const to = "2026-07-15T03:00:00.000Z";
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
    chat: jest.fn(async (_id: string, messages: Array<{ role: string; content: string }>) => {
      const system = messages[0]?.content ?? "";
      if (system.includes("factual claim")) {
        return {
          content: JSON.stringify({
            claims: [{ claim: "七天内可以退款", supported: true, reason: "知识片段明确支持" }],
          }),
        };
      }
      if (system.includes("one to three concise questions")) {
        return { content: JSON.stringify({ questions: ["退款期限多久"] }) };
      }
      const input = JSON.parse(messages[1]?.content ?? "{}") as {
        contexts?: Array<{ chunkId: string }>;
      };
      return {
        content: JSON.stringify({
          judgments: (input.contexts ?? []).map((context) => ({
            chunkId: context.chunkId,
            relevant: false,
            reason: "测试夹具将该片段标记为低分，以覆盖低质量筛选链路",
          })),
        }),
      };
    }),
    embedTexts: jest.fn(async (_id: string, texts: string[]) => texts.map(() => [1, 0, 0])),
  };

  const settingsUpdate = {
    enabled: true,
    sampleRate: 1,
    judgeModelId: E2E_JUDGE_MODEL_ID,
    embeddingModelId: E2E_EMBED_MODEL_ID,
    faithfulnessThreshold: 85,
    answerRelevancyThreshold: 80,
    contextPrecisionThreshold: 80,
    dailyCap: 500,
  };

  const evalAttributes = (traceId: string, version: string, score: number) => ({
    "rag.eval.status": "success",
    "rag.eval.target_trace_id": traceId,
    "rag.eval.dedupe_key": evalDedupeKey(traceId, version),
    "rag.eval.version": version,
    "rag.eval.faithfulness": String(score),
    "rag.eval.answer_relevancy": String(score),
    "rag.eval.context_precision": String(score),
    "rag.eval.judge_model": "judge-1",
    "gen_ai.agent.id": "agent-e2e",
    "gen_ai.request.model": "generation-1",
  });

  beforeAll(async () => {
    harness = await createEvaluationInfraHarness();
    await harness.resetAndMigrate();
    evaluationsRepo = new EvaluationsRepository(harness.db as never);
    clickhouseEvaluations = new ClickHouseEvaluationsRepository(harness.clickhouse);
    const conversations = new ConversationsService(
      new ConversationsRepository(harness.db as never),
    );
    const chunks = new ChunksService(
      new ChunksRepository(harness.db as never),
      new DocumentsRepository(harness.db as never),
    );
    const input = new EvaluationInputService(conversations, chunks);
    const judge = new EvaluationJudgeService(
      new FaithfulnessEvaluator(fakeModels as never),
      new AnswerRelevancyEvaluator(fakeModels as never),
      new ContextPrecisionEvaluator(fakeModels as never),
    );
    const emitter = {
      emitSuccess: jest.fn(
        async (payload: {
          candidate: { agentId: string; generationModel: string };
          input: { targetTraceId: string };
          settings: { judgeModelId: string; judgeVersion: string };
          result: {
            faithfulness: number;
            answerRelevancy: number;
            contextPrecision: number;
            evidence: unknown;
          };
        }) => {
          await harness.insertSpan({
            traceId: "e".repeat(32),
            spanId: "e".repeat(16),
            at: "2026-07-15T01:45:00.000Z",
            name: "rag.eval",
            attributes: {
              ...evalAttributes(
                payload.input.targetTraceId,
                payload.settings.judgeVersion,
                payload.result.faithfulness,
              ),
              "rag.eval.answer_relevancy": String(payload.result.answerRelevancy),
              "rag.eval.context_precision": String(payload.result.contextPrecision),
              "rag.eval.judge_model": payload.settings.judgeModelId,
              "gen_ai.agent.id": payload.candidate.agentId,
              "gen_ai.request.model": payload.candidate.generationModel,
              "codecrush.io.output": JSON.stringify(payload.result.evidence),
            },
          });
        },
      ),
      emitFailure: jest.fn(),
    };
    processor = new EvaluationWorkerProcessor(
      { subscribe: jest.fn(), schedule: jest.fn() } as never,
      evaluationsRepo,
      clickhouseEvaluations,
      input,
      judge,
      emitter as never,
      fakeModels as never,
    );
    service = new EvaluationsService(evaluationsRepo, clickhouseEvaluations, fakeModels as never);
    traces = new TracesService(new ClickHouseTracesRepository(harness.clickhouse));
    const ref = await Test.createTestingModule({
      controllers: [EvaluationsController, TracesController],
      providers: [
        { provide: EvaluationsService, useValue: service },
        { provide: TracesService, useValue: traces },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
      ],
    }).compile();
    app = ref.createNestApplication();
    applyGlobalConfig(app);
    await app.init();
  });

  afterEach(async () => harness.cleanup([targetTraceId, previewTraceId]));
  afterAll(async () => {
    await app.close();
    await harness.close();
  });

  it("runs worker to quality and Trace APIs without external model calls", async () => {
    await evaluationsRepo.updateSettings(settingsUpdate);
    await evaluationsRepo.getOrCreateWatermark("online-quality-v1", fixedNow);
    await harness.pool.query(
      "UPDATE eval_watermarks SET last_ts=$1,last_trace_id='' WHERE worker_name=$2",
      ["2026-07-15T01:00:00.000Z", "online-quality-v1"],
    );
    const { chunkId } = await harness.seedPgInput(targetTraceId);
    await harness.insertSpan({
      traceId: targetTraceId,
      spanId: "1".repeat(16),
      at: "2026-07-15T01:30:00.000Z",
      name: "rag.pipeline",
      attributes: {
        "codecrush.span.kind": "chain",
        "rag.preview": "false",
        "codecrush.io.input": "退款期限多久",
        "codecrush.io.output": "七天内可以退款",
        "gen_ai.agent.id": "agent-e2e",
        "gen_ai.agent.name": "退款助手",
        "gen_ai.request.model": "generation-1",
        "rag.fallback.used": "true",
        "rag.quality.no_citations": "true",
      },
    });
    await harness.insertSpan({
      traceId: targetTraceId,
      spanId: "2".repeat(16),
      parentSpanId: "1".repeat(16),
      at: "2026-07-15T01:30:01.000Z",
      name: "rag.retrieve",
      attributes: {
        "codecrush.span.kind": "retrieval",
        "rag.chunk.scores": JSON.stringify([{ chunkId, final: 0.9 }]),
      },
    });
    await harness.insertSpan({
      traceId: previewTraceId,
      spanId: "3".repeat(16),
      at: "2026-07-15T01:31:00.000Z",
      name: "rag.pipeline",
      attributes: {
        "codecrush.span.kind": "chain",
        "rag.preview": "true",
        "gen_ai.agent.id": "agent-e2e",
      },
    });

    const result = await processor.processCycle("online-quality-v1", fixedNow);
    expect(result.evaluatedCount).toBe(1);
    let detail: TraceQualityDetail = { status: "unscored" };
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      detail = await service.getTraceQuality(targetTraceId);
      if (detail.status === "scored") break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(detail).toMatchObject({ status: "scored", judgeVersion: "online-v1" });
    const overview = await service.getOverview({ from, to });
    const list = await traces.listTraces({ page: 1, pageSize: 20, evalVerdict: "low" });
    expect(overview.meta.evaluatedCount).toBe(1);
    expect(list.items.find((item) => item.traceId === targetTraceId)?.evaluation.status).toBe(
      "scored",
    );

    await request(app.getHttpServer())
      .get("/api/eval/quality/overview")
      .query({ from, to })
      .expect(200)
      .expect((response) => expect(response.body.meta.evaluatedCount).toBe(1));
    await request(app.getHttpServer())
      .get(`/api/eval/quality/traces/${targetTraceId}`)
      .expect(200)
      .expect((response) =>
        expect(response.body).toMatchObject({ status: "scored", currentVersion: true }),
      );
    await request(app.getHttpServer())
      .get("/api/eval/quality/settings")
      .expect(200)
      .expect((response) =>
        expect(response.body.models).toEqual(
          expect.objectContaining({ judges: expect.any(Array), embeddings: expect.any(Array) }),
        ),
      );
    await request(app.getHttpServer())
      .put("/api/eval/quality/settings")
      .send({
        enabled: true,
        judgeModelId: E2E_JUDGE_MODEL_ID,
        embeddingModelId: E2E_EMBED_MODEL_ID,
      })
      .expect(200);
    await request(app.getHttpServer())
      .get("/api/traces")
      .query({ evalVerdict: "low", page: 1, pageSize: 20 })
      .expect(200)
      .expect((response) =>
        expect(
          response.body.items.some((row: { traceId: string }) => row.traceId === targetTraceId),
        ).toBe(true),
      );
    await expect(
      clickhouseEvaluations.findExisting(previewTraceId, "online-v1"),
    ).resolves.toBeUndefined();
  });

  it("deduplicates cross-minute retry spans in the API", async () => {
    await harness.seedPgInput(targetTraceId);
    await evaluationsRepo.updateSettings(settingsUpdate);
    await harness.insertSpan({
      traceId: "c".repeat(32),
      spanId: "4".repeat(16),
      at: "2026-07-15T01:59:59.000Z",
      name: "rag.eval",
      attributes: evalAttributes(targetTraceId, "online-v1", 40),
    });
    await harness.insertSpan({
      traceId: "d".repeat(32),
      spanId: "5".repeat(16),
      at: "2026-07-15T02:00:01.000Z",
      name: "rag.eval",
      attributes: evalAttributes(targetTraceId, "online-v1", 90),
    });
    const overview = await service.getOverview({ from, to });
    expect(overview.meta.evaluatedCount).toBe(1);
    expect(overview.metrics.faithfulness.value).toBe(90);
  });

  it("never evaluates a preview-only trace", async () => {
    await harness.seedPgInput(targetTraceId);
    await evaluationsRepo.updateSettings(settingsUpdate);
    await evaluationsRepo.getOrCreateWatermark("online-quality-v1", fixedNow);
    await harness.pool.query(
      "UPDATE eval_watermarks SET last_ts=$1,last_trace_id='' WHERE worker_name=$2",
      ["2026-07-15T01:00:00.000Z", "online-quality-v1"],
    );
    await harness.insertSpan({
      traceId: previewTraceId,
      spanId: "6".repeat(16),
      at: "2026-07-15T01:30:00.000Z",
      name: "rag.pipeline",
      attributes: {
        "codecrush.span.kind": "chain",
        "rag.preview": "true",
        "gen_ai.agent.id": "agent-e2e",
      },
    });
    const result = await processor.processCycle("online-quality-v1", fixedNow);
    expect(result.evaluatedCount).toBe(0);
    await expect(service.getTraceQuality(previewTraceId)).resolves.toEqual({
      status: "unscored",
    });
  });

  it("falls back to an older successful version and marks it non-current", async () => {
    await harness.seedPgInput(targetTraceId);
    await evaluationsRepo.updateSettings(settingsUpdate);
    await harness.insertSpan({
      traceId: "f".repeat(32),
      spanId: "7".repeat(16),
      at: "2026-07-15T01:30:00.000Z",
      name: "rag.eval",
      attributes: evalAttributes(targetTraceId, "online-v0", 70),
    });
    await expect(service.getTraceQuality(targetTraceId)).resolves.toMatchObject({
      status: "scored",
      judgeVersion: "online-v0",
      currentVersion: false,
    });
  });
});
