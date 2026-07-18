import { describe, expect, it } from "vitest";
import {
  CODECRUSH_IO,
  CODECRUSH_REDACTED,
  CODECRUSH_SPAN_KIND,
  ENDUSER_ID,
  EVALUATION_UNSCORED_SCORE,
  GEN_AI,
  OTEL_OPERATIONS,
  RAG,
  SESSION_ID,
} from "./index";

describe("otel conventions", () => {
  it("exposes stable GenAI and RAG attribute keys", () => {
    expect(GEN_AI.REQUEST_MODEL).toBe("gen_ai.request.model");
    expect(GEN_AI.OPERATION_NAME).toBe("gen_ai.operation.name");
    expect(RAG.RETRIEVAL_TOP_K).toBe("rag.retrieval.top_k");
  });

  it("E-W1 eval attribute keys stay stable", () => {
    expect(RAG.EVAL_TARGET_TRACE_ID).toBe("rag.eval.target_trace_id");
    expect(RAG.EVAL_FAITHFULNESS).toBe("rag.eval.faithfulness");
    expect(RAG.EVAL_ANSWER_RELEVANCY).toBe("rag.eval.answer_relevancy");
    expect(RAG.EVAL_CONTEXT_PRECISION).toBe("rag.eval.context_precision");
    expect(RAG.EVAL_JUDGE_MODEL).toBe("rag.eval.judge_model");
    expect(RAG.EVAL_VERSION).toBe("rag.eval.version");
    expect(RAG.EVAL_DEDUPE_KEY).toBe("rag.eval.dedupe_key");
    expect(RAG.EVAL_STATUS).toBe("rag.eval.status");
    expect(RAG.EVAL_TRIGGER).toBe("rag.eval.trigger");
  });

  it("reserves -1 for an unscored evaluation metric", () => {
    expect(EVALUATION_UNSCORED_SCORE).toBe(-1);
  });

  it("exposes generic operation and span kind names", () => {
    expect(OTEL_OPERATIONS.CHAT).toBe("chat");
    expect(OTEL_OPERATIONS.RETRIEVE).toBe("retrieve");
    expect(CODECRUSH_SPAN_KIND.LLM).toBe("llm");
    expect(CODECRUSH_SPAN_KIND.CUSTOM).toBe("custom");
  });

  it("CODECRUSH_SPAN_KIND 含 CHAIN（编排根 span）", () => {
    expect(CODECRUSH_SPAN_KIND.CHAIN).toBe("chain");
  });

  it("M8 T3：质量信号四布尔键稳定", () => {
    expect(RAG.QUALITY_LOW_RECALL).toBe("rag.quality.low_recall");
    expect(RAG.QUALITY_NO_CITATIONS).toBe("rag.quality.no_citations");
    expect(RAG.QUALITY_REFUSAL).toBe("rag.quality.refusal");
    expect(RAG.QUALITY_TIMEOUT).toBe("rag.quality.timeout");
  });

  it("M8 T3：通用 IO 与脱敏标记键稳定", () => {
    expect(CODECRUSH_IO.INPUT).toBe("codecrush.io.input");
    expect(CODECRUSH_IO.OUTPUT).toBe("codecrush.io.output");
    expect(CODECRUSH_REDACTED).toBe("codecrush.redacted");
  });

  it("M9：意图路由键稳定（intent 节点 span）", () => {
    expect(RAG.INTENT).toBe("rag.intent");
    expect(RAG.ROUTE_KB_NAMES).toBe("rag.route.kb_names");
  });

  it("M9 W1：身份约定键用 OTel 标准键名", () => {
    expect(SESSION_ID).toBe("session.id");
    expect(ENDUSER_ID).toBe("enduser.id");
  });
});
