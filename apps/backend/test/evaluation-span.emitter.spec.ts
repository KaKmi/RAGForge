import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { CODECRUSH_IO, GEN_AI, RAG } from "@codecrush/otel-conventions";
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
});
