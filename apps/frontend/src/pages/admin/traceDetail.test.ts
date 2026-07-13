import { describe, expect, it } from "vitest";
import type { TraceSpan } from "@codecrush/contracts";
import { autoSelectSpan, buildOtlpJson, buildSpanDetail, buildWaterfall, spanKindColor } from "./traceDetail";

const mk = (o: Partial<TraceSpan>): TraceSpan => ({
  traceId: "a".repeat(32),
  spanId: "s",
  parentSpanId: null,
  name: "n",
  kind: "chain",
  startTime: "2026-07-13T09:11:00.000Z",
  durationMs: 100,
  statusCode: "Ok",
  statusMessage: null,
  attributes: {},
  ...o,
});

describe("traceDetail", () => {
  it("kind 颜色映射（未知兜底）", () => {
    expect(spanKindColor("retrieval").label).toBe("检索");
    expect(spanKindColor("weird").c).toBeTruthy();
  });

  it("autoSelectSpan 选首个 ERROR", () => {
    const spans = [mk({ spanId: "r" }), mk({ spanId: "e", statusCode: "Error" })];
    expect(autoSelectSpan(spans, null)).toBe("e");
  });

  it("autoSelectSpan 保留有效选中", () => {
    const spans = [mk({ spanId: "r" }), mk({ spanId: "e", statusCode: "Error" })];
    expect(autoSelectSpan(spans, "r")).toBe("r");
  });

  it("buildWaterfall 排除 root、offset 相对 root、缩进按深度", () => {
    const spans = [
      mk({ spanId: "root", kind: "chain", startTime: "2026-07-13T09:11:00.000Z", durationMs: 1000 }),
      mk({ spanId: "child", parentSpanId: "root", startTime: "2026-07-13T09:11:00.400Z", durationMs: 200, kind: "retrieval" }),
      mk({ spanId: "grand", parentSpanId: "child", startTime: "2026-07-13T09:11:00.450Z", durationMs: 100, kind: "embeddings" }),
    ];
    const wf = buildWaterfall(spans, "child");
    // root 不进瀑布行（单独作 TRACE 头行）
    expect(wf.find((w) => w.sid === "root")).toBeUndefined();
    const child = wf.find((w) => w.sid === "child")!;
    expect(child.offsetMs).toBe(400);
    expect(child.indent).toBe(0); // root 直接子 → 0
    expect(wf.find((w) => w.sid === "grand")!.indent).toBe(20); // 孙节点 → 20
  });

  it("buildSpanDetail 解析 chunk.scores（doc + pass 阈值）", () => {
    const span = mk({
      kind: "retrieval",
      attributes: {
        "rag.chunk.scores": JSON.stringify([
          { chunkId: "c1", doc: "退款政策", vec: 0.9, kw: 0.1, rerank: 0.8, final: 0.85 },
          { chunkId: "c2", doc: "淘汰块", vec: 0.4, kw: null, rerank: 0.3, final: 0.4 },
        ]),
      },
    });
    const d = buildSpanDetail(span, span);
    expect(d.scores[0]).toMatchObject({ doc: "退款政策", rr: 0.8, pass: true });
    expect(d.scores[1].pass).toBe(false);
  });

  it("buildSpanDetail 根 span 解析 citation.ids + io", () => {
    const root = mk({
      spanId: "root",
      attributes: {
        "rag.citation.ids": JSON.stringify([{ n: 1, doc: "政策", score: 0.9 }]),
        "codecrush.io.input": "问",
        "codecrush.io.output": "答",
      },
    });
    const d = buildSpanDetail(root, root);
    expect(d.cites[0]).toMatchObject({ n: 1, doc: "政策" });
    expect(d.input).toBe("问");
    expect(d.output).toBe("答");
  });

  it("buildSpanDetail 非根节点无 io/citation", () => {
    const root = mk({ spanId: "root" });
    const child = mk({ spanId: "c", parentSpanId: "root", kind: "llm", attributes: { "codecrush.io.input": "x" } });
    const d = buildSpanDetail(child, root);
    expect(d.input).toBeNull();
    expect(d.cites).toEqual([]);
  });

  it("buildSpanDetail 错误框用 statusMessage", () => {
    const span = mk({ statusCode: "Error", statusMessage: "上游超时" });
    const d = buildSpanDetail(span, span);
    expect(d.isErr).toBe(true);
    expect(d.errMsg).toBe("上游超时");
  });

  it("buildOtlpJson 含 span 数组 + offset", () => {
    const spans = [mk({ spanId: "root", durationMs: 100 })];
    const json = JSON.parse(
      buildOtlpJson("a".repeat(32), {
        userInput: "", agentName: null, genModel: null, genModelVersion: null, promptVersionId: null,
        durationMs: 100, inputTokens: 0, outputTokens: 0, cost: null, status: "success", qualitySignals: [],
      }, spans),
    );
    expect(json.spans[0]).toMatchObject({ spanId: "root", startOffsetMs: 0 });
  });
});
