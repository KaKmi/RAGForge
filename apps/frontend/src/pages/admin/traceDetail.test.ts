import { describe, expect, it } from "vitest";
import type { TraceSpan } from "@codecrush/contracts";
import { autoSelectSpan, buildContractChain, buildOtlpJson, buildSpanDetail, buildSpanMeta, buildWaterfall, rootSpanOf, rewrittenQueryOf, spanKindColor, traceAlerts } from "./traceDetail";

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

  it("HTTP 埋点场景：chain span 挂在 POST server span 下——按 kind 认根、排除 HTTP span", () => {
    const spans = [
      mk({ spanId: "http", kind: "Server", parentSpanId: null, name: "POST /api/chat", startTime: "2026-07-13T09:11:00.000Z", durationMs: 2600 }),
      mk({ spanId: "chain", kind: "chain", parentSpanId: "http", name: "rag.pipeline", startTime: "2026-07-13T09:11:00.050Z", durationMs: 2400 }),
      mk({ spanId: "reply", kind: "llm", parentSpanId: "chain", name: "node.reply", startTime: "2026-07-13T09:11:00.700Z", durationMs: 1700 }),
    ];
    // 根按 kind='chain' 认（非 parentSpanId===null 的 HTTP span）
    expect(rootSpanOf(spans)!.spanId).toBe("chain");
    const wf = buildWaterfall(spans, "reply");
    // HTTP span 与 chain 自身都不进瀑布行；只剩 chain 子树内的 reply
    expect(wf.map((w) => w.sid)).toEqual(["reply"]);
    // offset 相对 chain 起点（09:11:00.700 − 09:11:00.050 = 650ms），reply 为 chain 直接子 → indent 0
    expect(wf[0].offsetMs).toBe(650);
    expect(wf[0].indent).toBe(0);
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
    expect(wf.find((w) => w.sid === "grand")!.indent).toBe(24); // 孙节点 → 24
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

  // 批 A：每节点面板铺料（属性值都是 CH Map(String,String) 的字符串）
  const rowV = (rows: { k: string; v: string; tone?: string }[], k: string) => rows.find((r) => r.k === k);

  it("buildSpanMeta LLM 节点：模型/输出模式/修复重试(warn)/校验错误码(err)/降级", () => {
    const rows = buildSpanMeta(
      mk({
        kind: "llm",
        attributes: {
          "gen_ai.request.model": "deepseek-v3",
          "gen_ai.system": "openai",
          "rag.structured_output.mode": "json_schema",
          "rag.repair.retry_count": "1",
          "rag.validation.error_code": "SCHEMA_MISMATCH",
          "rag.fallback.used": "true",
        },
      }),
    );
    expect(rowV(rows, "模型")?.v).toBe("deepseek-v3");
    expect(rowV(rows, "输出模式")?.v).toBe("json_schema");
    expect(rowV(rows, "修复重试")).toMatchObject({ v: "1 次", tone: "warn" });
    expect(rowV(rows, "校验错误码")).toMatchObject({ v: "SCHEMA_MISMATCH", tone: "err" });
    expect(rowV(rows, "降级")).toMatchObject({ tone: "warn" });
  });

  it("buildSpanMeta LLM 正常：修复重试=0 与无校验错误 均不显示", () => {
    const rows = buildSpanMeta(mk({ kind: "llm", attributes: { "rag.repair.retry_count": "0", "rag.fallback.used": "false" } }));
    expect(rowV(rows, "修复重试")).toBeUndefined();
    expect(rowV(rows, "校验错误码")).toBeUndefined();
    expect(rowV(rows, "降级")).toBeUndefined();
  });

  it("buildSpanMeta 检索节点：topK/阈值/融合权重(向量·关键词)/rerank阈值/多路", () => {
    const rows = buildSpanMeta(
      mk({
        kind: "retrieval",
        attributes: {
          "rag.retrieval.top_k": "5",
          "rag.retrieval.threshold": "0.5",
          "rag.retrieval.vec_weight": "0.7",
          "rag.rerank.threshold": "0.65",
          "rag.multi": "true",
        },
      }),
    );
    expect(rowV(rows, "Top K")?.v).toBe("5");
    expect(rowV(rows, "召回阈值")?.v).toBe("0.5");
    expect(rowV(rows, "融合权重")?.v).toBe("向量 0.7 · 关键词 0.3");
    expect(rowV(rows, "Rerank 阈值")?.v).toBe("0.65");
    expect(rowV(rows, "多路召回")?.v).toBe("是");
  });

  it("buildSpanMeta 向量/重排节点出各自模型", () => {
    expect(rowV(buildSpanMeta(mk({ kind: "embeddings", attributes: { "gen_ai.request.model": "bge-m3" } })), "向量模型")?.v).toBe("bge-m3");
    expect(rowV(buildSpanMeta(mk({ kind: "rerank", attributes: { "gen_ai.request.model": "bge-reranker" } })), "重排模型")?.v).toBe("bge-reranker");
  });

  // #1 NodeContract 校验链
  it("buildContractChain 降级路径：结构化输出→首次校验(码)→修复1次→降级兜底", () => {
    const chain = buildContractChain(
      mk({ kind: "llm", attributes: { "rag.structured_output.mode": "json_schema", "rag.validation.error_code": "SCHEMA_MISMATCH", "rag.repair.retry_count": "1", "rag.fallback.used": "true" } }),
    );
    expect(chain.map((s) => s.label)).toEqual(["结构化输出", "首次校验", "修复 1 次", "降级兜底"]);
    expect(chain[1]).toMatchObject({ status: "err", detail: "SCHEMA_MISMATCH" });
    expect(chain[3]).toMatchObject({ status: "err" });
  });

  it("buildContractChain 一次通过：结构化输出→校验通过", () => {
    const chain = buildContractChain(mk({ kind: "llm", attributes: { "rag.structured_output.mode": "json_schema", "rag.repair.retry_count": "0", "rag.fallback.used": "false" } }));
    expect(chain.map((s) => s.label)).toEqual(["结构化输出", "校验通过"]);
    expect(chain.every((s) => s.status === "ok")).toBe(true);
  });

  it("buildContractChain 修复后通过：修复步 warn、终态 修复通过 ok", () => {
    const chain = buildContractChain(mk({ kind: "llm", attributes: { "rag.validation.error_code": "MISSING_FIELD", "rag.repair.retry_count": "1", "rag.fallback.used": "false" } }));
    expect(chain.map((s) => s.label)).toEqual(["结构化输出", "首次校验", "修复 1 次", "修复通过"]);
    expect(chain[2].status).toBe("warn");
    expect(chain[3].status).toBe("ok");
  });

  it("buildContractChain 非 LLM / 无契约信号 → 空（不渲染）", () => {
    expect(buildContractChain(mk({ kind: "retrieval", attributes: {} }))).toEqual([]);
    expect(buildContractChain(mk({ kind: "llm", attributes: {} }))).toEqual([]);
  });

  // #4 降级/异常置顶
  it("traceAlerts 汇总链内报错(err)与降级(warn)，排除 HTTP 传输 span", () => {
    const spans = [
      mk({ spanId: "http", kind: "Server", parentSpanId: null, statusCode: "Error" }),
      mk({ spanId: "chain", kind: "chain", parentSpanId: "http" }),
      mk({ spanId: "ret", kind: "retrieval", parentSpanId: "chain", statusCode: "Error", statusMessage: "上游超时" }),
      mk({ spanId: "llm", kind: "llm", parentSpanId: "chain", attributes: { "rag.fallback.used": "true" } }),
    ];
    const al = traceAlerts(spans);
    // http（不在 chain 子树）不计入；仅 ret(err) + llm(fallback)
    expect(al.map((a) => a.sid)).toEqual(["ret", "llm"]);
    expect(al[0]).toMatchObject({ tone: "err", msg: "上游超时" });
    expect(al[1]).toMatchObject({ tone: "warn" });
  });

  // #3 耗时占比
  it("buildSpanDetail / buildWaterfall 计算占总时长百分比", () => {
    const root = mk({ spanId: "root", kind: "chain", durationMs: 1000, startTime: "2026-07-13T09:11:00.000Z" });
    const child = mk({ spanId: "c", kind: "llm", parentSpanId: "root", durationMs: 640, startTime: "2026-07-13T09:11:00.100Z" });
    expect(buildSpanDetail(child, root).durationPct).toBe(64);
    expect(buildWaterfall([root, child], "c").find((w) => w.sid === "c")!.pctOfTotal).toBe(64);
  });

  // #2 意图→KB 路由
  it("buildSpanDetail 意图节点解析 routing（意图 + 路由 KB 名）", () => {
    const root = mk({ spanId: "root" });
    const intent = mk({ spanId: "i", parentSpanId: "root", kind: "llm", attributes: { "rag.intent": "SUPPORT", "rag.route.kb_names": JSON.stringify(["售后库", "订单FAQ"]) } });
    expect(buildSpanDetail(intent, root).routing).toEqual({ intent: "SUPPORT", kbNames: ["售后库", "订单FAQ"] });
  });

  it("buildSpanDetail 非意图节点 routing 为 null；CHAT 空路由 kbNames=[]", () => {
    const root = mk({ spanId: "root" });
    expect(buildSpanDetail(mk({ spanId: "r", kind: "retrieval", parentSpanId: "root" }), root).routing).toBeNull();
    const chat = mk({ spanId: "i", parentSpanId: "root", kind: "llm", attributes: { "rag.intent": "CHAT", "rag.route.kb_names": "[]" } });
    expect(buildSpanDetail(chat, root).routing).toEqual({ intent: "CHAT", kbNames: [] });
  });

  it("buildOtlpJson 含 span 数组 + offset", () => {
    const spans = [mk({ spanId: "root", durationMs: 100 })];
    const json = JSON.parse(
      buildOtlpJson("a".repeat(32), {
        userInput: "", agentId: null, agentName: null, genModel: null, genModelVersion: null, promptVersionId: null,
        durationMs: 100, inputTokens: 0, outputTokens: 0, cost: null, status: "success", qualitySignals: [],
      }, spans),
    );
    expect(json.spans[0]).toMatchObject({ spanId: "root", startOffsetMs: 0 });
  });

  /**
   * `rag.rewrite.query` 一直埋着，但此前没被任何地方提取——后果不止是面板上少一块：
   * 「加入问题池」也拿不到它，于是手动入池的样本被误标「指代未消解」，
   * 聚类键退回原文（021 决策 F 被架空），回验拿带指代的原话去重放 ⇒ 假的「复发」标。
   */
  describe("rewrittenQueryOf", () => {
    it("从 rewrite 节点取出改写后的问题", () => {
      const spans = [
        mk({ spanId: "root", name: "rag.pipeline" }),
        mk({
          spanId: "rw",
          name: "node_runtime.execute_structured",
          attributes: { "rag.node.name": "rewrite", "rag.rewrite.query": "如何回应下属的加薪请求？" },
        }),
      ];
      expect(rewrittenQueryOf(spans)).toBe("如何回应下属的加薪请求？");
    });

    it("没有 rewrite 结果 ⇒ null（调用方据此退回保守默认，而不是传空串）", () => {
      expect(rewrittenQueryOf([mk({ spanId: "root" })])).toBeNull();
    });

    it("空白字符串当作没有——传上去会被契约的 .min(1) 打回，整个入池请求失败", () => {
      const spans = [mk({ spanId: "rw", attributes: { "rag.rewrite.query": "   " } })];
      expect(rewrittenQueryOf(spans)).toBeNull();
    });

    it("顺带 trim：前后空白会被原样当成代表问题的显示身份", () => {
      const spans = [mk({ spanId: "rw", attributes: { "rag.rewrite.query": "  改写后  " } })];
      expect(rewrittenQueryOf(spans)).toBe("改写后");
    });
  });

  it("buildSpanDetail 提取 rewrittenQuery，且只挂在产出它的那个节点上", () => {
    const root = mk({ spanId: "root", name: "rag.pipeline" });
    const rw = mk({
      spanId: "rw",
      attributes: { "rag.rewrite.query": "改写后的问题" },
    });

    expect(buildSpanDetail(rw, root).rewrittenQuery).toBe("改写后的问题");
    // 别的节点不该跟着显示它——那会让人以为每一步都改写了一次。
    expect(buildSpanDetail(mk({ spanId: "other" }), root).rewrittenQuery).toBeNull();
  });
});
