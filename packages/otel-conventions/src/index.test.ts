import { describe, expect, it } from "vitest";
import {
  CODECRUSH_IO,
  CODECRUSH_REDACTED,
  CODECRUSH_SPAN_KIND,
  GEN_AI,
  OTEL_OPERATIONS,
  RAG,
} from "./index";

describe("otel conventions", () => {
  it("exposes stable GenAI and RAG attribute keys", () => {
    expect(GEN_AI.REQUEST_MODEL).toBe("gen_ai.request.model");
    expect(GEN_AI.OPERATION_NAME).toBe("gen_ai.operation.name");
    expect(RAG.RETRIEVAL_TOP_K).toBe("rag.retrieval.top_k");
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
});
