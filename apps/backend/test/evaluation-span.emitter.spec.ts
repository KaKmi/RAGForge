import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { CODECRUSH_IO, EVALUATION_UNSCORED_SCORE, GEN_AI, RAG } from "@codecrush/otel-conventions";
import { EvaluationSpanEmitter } from "../src/modules/evaluations/evaluation-span.emitter";
import { evalDedupeKey } from "../src/modules/evaluations/sampling";

const candidate = {
  traceId: "a".repeat(32),
  startTime: new Date("2026-07-15T01:00:00.000Z"),
  agentId: "app-1",
  generationModel: "qwen",
  status: "success" as const,
  noCitations: false,
  confidence: 0.9,
  retrievalChunks: [],
};
const input = {
  targetTraceId: candidate.traceId,
  question: "退款多久",
  answer: "七天",
  contexts: [],
};
const settings = { judgeModelId: "judge-1", judgeVersion: "online-v1" };

describe("EvaluationSpanEmitter", () => {
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    trace.disable();
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
    );
  });

  afterEach(() => trace.disable());

  it("emits the frozen success attributes and evidence only in the protected output key", async () => {
    const result = {
      faithfulness: 90,
      answerRelevancy: 80,
      contextPrecision: 70,
      evidence: {
        faithfulness: ["supported"],
        answerRelevancy: ["relevant"],
        contextPrecision: ["rank 1"],
      },
    };
    await new EvaluationSpanEmitter().emitSuccess({ candidate, input, settings, result });
    const span = exporter.getFinishedSpans()[0];
    expect(span.name).toBe("rag.eval");
    expect(span.attributes).toMatchObject({
      [RAG.EVAL_STATUS]: "success",
      [RAG.EVAL_TARGET_TRACE_ID]: candidate.traceId,
      [RAG.EVAL_DEDUPE_KEY]: evalDedupeKey(candidate.traceId, "online-v1"),
      [RAG.EVAL_FAITHFULNESS]: 90,
      [RAG.EVAL_ANSWER_RELEVANCY]: 80,
      [RAG.EVAL_CONTEXT_PRECISION]: 70,
      [RAG.EVAL_JUDGE_MODEL]: "judge-1",
      [RAG.EVAL_VERSION]: "online-v1",
      [GEN_AI.AGENT_ID]: "app-1",
      [GEN_AI.REQUEST_MODEL]: "qwen",
      [CODECRUSH_IO.OUTPUT]: JSON.stringify(result.evidence),
    });
    expect(span.attributes["rag.eval.judge_version"]).toBeUndefined();
    expect(span.attributes["rag.eval.agent_id"]).toBeUndefined();
  });

  it("emits a bounded failure without scores, evidence, or provider body attributes", async () => {
    await new EvaluationSpanEmitter().emitFailure({
      input,
      settings,
      error: new TypeError(`provider body ${"x".repeat(250)}`),
    });
    const attributes = exporter.getFinishedSpans()[0].attributes;
    expect(attributes[RAG.EVAL_STATUS]).toBe("failed");
    expect(attributes["error.type"]).toBe("TypeError");
    expect(String(attributes["error.message"]).length).toBeLessThanOrEqual(200);
    expect(attributes[RAG.EVAL_FAITHFULNESS]).toBeUndefined();
    expect(attributes[CODECRUSH_IO.OUTPUT]).toBeUndefined();
    expect(attributes["rag.eval.error"]).toBeUndefined();
  });

  it("emits the transport sentinel when faithfulness is intentionally unscored", async () => {
    await new EvaluationSpanEmitter().emitSuccess({
      candidate,
      input,
      settings: { ...settings, judgeVersion: "online-v2" },
      result: {
        faithfulness: null,
        answerRelevancy: 80,
        contextPrecision: 70,
        evidence: {
          answerRelevancy: ["relevant"],
          contextPrecision: ["rank 1"],
        },
      },
    });

    const attributes = exporter.getFinishedSpans()[0].attributes;
    expect(attributes[RAG.EVAL_FAITHFULNESS]).toBe(EVALUATION_UNSCORED_SCORE);
    expect(JSON.parse(String(attributes[CODECRUSH_IO.OUTPUT]))).not.toHaveProperty("faithfulness");
  });
  /**
   * B1/F3：`rag.eval.trigger` 此前**只被处理器侧的假 emitter 断言过**——真 emitter
   * 删掉那两行属性，全仓测试依然全绿（只有常量名被 otel-conventions 的用例钉住）。
   * 这两条用例钉的是真 emitter：默认 worker（既有 worker 调用点零改动的前提），
   * 显式 manual（B2 若要从聚合里剔除人工样本，全靠这个属性）。
   */
  it("defaults rag.eval.trigger to worker on success spans", async () => {
    await new EvaluationSpanEmitter().emitSuccess({
      candidate,
      input,
      settings,
      result: { faithfulness: 90, answerRelevancy: 80, contextPrecision: 70, evidence: {} },
    });
    expect(exporter.getFinishedSpans()[0].attributes[RAG.EVAL_TRIGGER]).toBe("worker");
  });

  it("carries rag.eval.trigger=manual on both success and failure spans", async () => {
    const manual = { ...settings, trigger: "manual" as const };
    const emitter = new EvaluationSpanEmitter();
    await emitter.emitSuccess({
      candidate,
      input,
      settings: manual,
      result: { faithfulness: 90, answerRelevancy: 80, contextPrecision: 70, evidence: {} },
    });
    await emitter.emitFailure({ input, settings: manual, error: new Error("judge down") });

    const [success, failure] = exporter.getFinishedSpans();
    expect(success.attributes[RAG.EVAL_TRIGGER]).toBe("manual");
    expect(failure.attributes[RAG.EVAL_TRIGGER]).toBe("manual");
  });

  it("defaults rag.eval.trigger to worker on failure spans", async () => {
    await new EvaluationSpanEmitter().emitFailure({
      input,
      settings,
      error: new Error("judge down"),
    });
    expect(exporter.getFinishedSpans()[0].attributes[RAG.EVAL_TRIGGER]).toBe("worker");
  });
});
