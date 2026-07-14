import { context, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { PgHybridRetriever } from "../src/modules/retrieval/adapters/pg-hybrid-retriever.adapter";
import type { ChunksService } from "../src/modules/chunks/chunks.service";
import type { ModelsService } from "../src/modules/models/models.service";
import type { KnowledgeBasesService } from "../src/modules/knowledge-bases/knowledge-bases.service";

const kb = { id: "kb1", activeVersion: 3 };
const baseReq = {
  query: "退货政策",
  kbId: "kb1",
  embedModelId: "m2",
  topK: 10,
  threshold: 0.5,
  multi: true,
};

function makeDeps(
  overrides: {
    vecRows?: unknown[];
    kwRows?: unknown[];
    vecFails?: boolean;
    kwFails?: boolean;
    rerankResults?: unknown[];
    rerankFails?: boolean;
    embedFails?: boolean;
  } = {},
) {
  const chunks = {
    searchByVector: jest.fn(async () => {
      if (overrides.vecFails) throw new Error("vector down");
      return overrides.vecRows ?? [];
    }),
    searchByKeyword: jest.fn(async () => {
      if (overrides.kwFails) throw new Error("keyword down");
      return overrides.kwRows ?? [];
    }),
  } as unknown as ChunksService;
  const models = {
    embedTexts: jest.fn(async () => {
      if (overrides.embedFails) throw new Error("embed down");
      return [[0.1, 0.2]];
    }),
    rerankTexts: jest.fn(async () => {
      if (overrides.rerankFails) throw new Error("rerank down");
      return overrides.rerankResults ?? [];
    }),
  } as unknown as ModelsService;
  const kbs = { get: jest.fn(async () => kb) } as unknown as KnowledgeBasesService;
  return { chunks, models, kbs };
}

describe("PgHybridRetriever.retrieve — 融合与阈值", () => {
  it("multi=false 时 finalScore = vecScore，不查关键词路", async () => {
    const { chunks, models, kbs } = makeDeps({
      vecRows: [
        { chunkId: "c1", docId: "d1", docName: "doc1", text: "t", section: "s", vecScore: 0.9 },
      ],
    });
    const retriever = new PgHybridRetriever(chunks, models, kbs);
    const hits = await retriever.retrieve({ ...baseReq, multi: false });
    expect(chunks.searchByKeyword).not.toHaveBeenCalled();
    expect(hits).toEqual([
      expect.objectContaining({ chunkId: "c1", vecScore: 0.9, kwScore: undefined, finalScore: 0.9 }),
    ]);
  });

  it("multi=true 时 finalScore = 加权线性和，权重默认 0.5", async () => {
    const { chunks, models, kbs } = makeDeps({
      vecRows: [
        { chunkId: "c1", docId: "d1", docName: "doc1", text: "t", section: "s", vecScore: 0.8 },
      ],
      kwRows: [
        { chunkId: "c1", docId: "d1", docName: "doc1", text: "t", section: "s", kwScore: 0.4 },
      ],
    });
    const retriever = new PgHybridRetriever(chunks, models, kbs);
    const [hit] = await retriever.retrieve({ ...baseReq, threshold: 0 });
    expect(hit.finalScore).toBeCloseTo(0.8 * 0.5 + 0.4 * 0.5, 5);
  });

  it("只被关键词路召回的 chunk，vecScore 缺省按 0 参与融合", async () => {
    const { chunks, models, kbs } = makeDeps({
      vecRows: [],
      kwRows: [
        { chunkId: "c2", docId: "d2", docName: "doc2", text: "t2", section: "s", kwScore: 0.6 },
      ],
    });
    const retriever = new PgHybridRetriever(chunks, models, kbs);
    const [hit] = await retriever.retrieve({ ...baseReq, vecWeight: 0.5, threshold: 0 });
    expect(hit.finalScore).toBeCloseTo(0 * 0.5 + 0.6 * 0.5, 5);
  });

  it("相似度阈值过滤：finalScore 低于 threshold 的候选被剔除", async () => {
    const { chunks, models, kbs } = makeDeps({
      vecRows: [
        { chunkId: "c1", docId: "d1", docName: "doc1", text: "t", section: "s", vecScore: 0.2 },
      ],
    });
    const retriever = new PgHybridRetriever(chunks, models, kbs);
    const hits = await retriever.retrieve({ ...baseReq, multi: false, threshold: 0.5 });
    expect(hits).toEqual([]);
  });
});

describe("PgHybridRetriever.retrieve — rerank 分支", () => {
  it("rerank 成功：finalScore 覆盖为 rerankScore，按 rerankThreshold 再过滤一次", async () => {
    const { chunks, models, kbs } = makeDeps({
      vecRows: [
        { chunkId: "c1", docId: "d1", docName: "doc1", text: "t1", section: "s", vecScore: 0.9 },
        { chunkId: "c2", docId: "d2", docName: "doc2", text: "t2", section: "s", vecScore: 0.8 },
      ],
      rerankResults: [
        { index: 0, score: 0.3 },
        { index: 1, score: 0.95 },
      ],
    });
    const retriever = new PgHybridRetriever(chunks, models, kbs);
    const hits = await retriever.retrieve({
      ...baseReq,
      multi: false,
      threshold: 0,
      rerankModelId: "rr1",
      rerankThreshold: 0.5,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual(
      expect.objectContaining({ chunkId: "c2", rerankScore: 0.95, finalScore: 0.95 }),
    );
  });

  it("rerank 失败/超时 → 降级跳过，finalScore 保留融合分，不抛出", async () => {
    const { chunks, models, kbs } = makeDeps({
      vecRows: [
        { chunkId: "c1", docId: "d1", docName: "doc1", text: "t", section: "s", vecScore: 0.9 },
      ],
      rerankFails: true,
    });
    const retriever = new PgHybridRetriever(chunks, models, kbs);
    const observer = jest.fn();
    const hits = await retriever.retrieve({
      ...baseReq,
      multi: false,
      threshold: 0,
      rerankModelId: "rr1",
    }, observer);
    expect(hits[0]).toEqual(
      expect.objectContaining({ chunkId: "c1", finalScore: 0.9, rerankScore: undefined }),
    );
    expect(observer).toHaveBeenCalledWith("rerank_degraded");
  });
});

describe("PgHybridRetriever.retrieve — 降级路径", () => {
  it("向量召回失败 → 硬失败，抛出", async () => {
    const { chunks, models, kbs } = makeDeps({ vecFails: true });
    const retriever = new PgHybridRetriever(chunks, models, kbs);
    await expect(retriever.retrieve(baseReq)).rejects.toThrow();
  });

  it("关键词召回失败 → 降级为纯向量继续，不抛出", async () => {
    const { chunks, models, kbs } = makeDeps({
      vecRows: [
        { chunkId: "c1", docId: "d1", docName: "doc1", text: "t", section: "s", vecScore: 0.9 },
      ],
      kwFails: true,
    });
    const retriever = new PgHybridRetriever(chunks, models, kbs);
    const observer = jest.fn();
    const hits = await retriever.retrieve({ ...baseReq, threshold: 0 }, observer);
    expect(hits[0]).toEqual(expect.objectContaining({ chunkId: "c1", finalScore: 0.9 }));
    expect(observer).toHaveBeenCalledWith("keyword_degraded");
  });

  it("keyword and rerank degradations are reported independently on the same retrieval", async () => {
    const { chunks, models, kbs } = makeDeps({
      vecRows: [{ chunkId: "c1", docId: "d1", docName: "doc1", text: "t", section: "s", vecScore: 0.9 }],
      kwFails: true,
      rerankFails: true,
    });
    const observer = jest.fn();
    const hits = await new PgHybridRetriever(chunks, models, kbs).retrieve({
      ...baseReq, threshold: 0, rerankModelId: "rr1",
    }, observer);
    expect(hits[0].finalScore).toBe(0.9);
    expect(observer.mock.calls.map(([signal]) => signal)).toEqual([
      "keyword_degraded", "rerank_degraded",
    ]);
  });
});

describe("PgHybridRetriever.retrieve — 候选池上限与 topN", () => {
  it("topK 低于平台上限时，召回池大小就是 topK 本身（不是恒等于上限）", async () => {
    const { chunks, models, kbs } = makeDeps();
    const retriever = new PgHybridRetriever(chunks, models, kbs);
    await retriever.retrieve({ ...baseReq, topK: 5 });
    const [, , , limitArg] = (chunks.searchByVector as jest.Mock).mock.calls[0];
    expect(limitArg).toBe(5);
  });

  it("topK 超过平台上限时，召回池大小被封顶（不随 topK 无界增长）", async () => {
    const { chunks, models, kbs } = makeDeps();
    const retriever = new PgHybridRetriever(chunks, models, kbs);
    await retriever.retrieve({ ...baseReq, topK: 500 });
    const [, , , limitArg] = (chunks.searchByVector as jest.Mock).mock.calls[0];
    expect(limitArg).toBeLessThanOrEqual(100);
    expect(limitArg).toBeLessThan(500);
  });

  it("kb.activeVersion 被用于两路召回的 version 参数", async () => {
    const { chunks, models, kbs } = makeDeps();
    const retriever = new PgHybridRetriever(chunks, models, kbs);
    await retriever.retrieve(baseReq);
    expect(chunks.searchByVector).toHaveBeenCalledWith(
      "kb1",
      3,
      expect.anything(),
      expect.anything(),
    );
  });

  it("topN 截断最终结果", async () => {
    const { chunks, models, kbs } = makeDeps({
      vecRows: [
        { chunkId: "c1", docId: "d1", docName: "d", text: "t", section: "s", vecScore: 0.9 },
        { chunkId: "c2", docId: "d2", docName: "d", text: "t", section: "s", vecScore: 0.8 },
      ],
    });
    const retriever = new PgHybridRetriever(chunks, models, kbs);
    const hits = await retriever.retrieve({ ...baseReq, multi: false, threshold: 0, topN: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0].chunkId).toBe("c1");
  });
});

// M8 T3：检索 span 三拆（embedding/rerank 子 span 自动挂父）+ 命中分表 rag.chunk.scores。
// 自动挂父依赖活动 ContextManager——jest harness 默认 NoopContextManager 会让子 span 挂到 root，
// 故此 describe 注册 AsyncLocalStorageContextManager（生产由 NodeSDK 自注册，见 node-sdk.ts）。
describe("PgHybridRetriever — 检索 span 三拆 + 命中分表 (M8 T3)", () => {
  let exporter: InMemorySpanExporter;
  const ctxManager = new AsyncLocalStorageContextManager();
  beforeAll(() => {
    context.setGlobalContextManager(ctxManager.enable());
  });
  afterAll(() => {
    context.disable();
    trace.disable();
  });
  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    trace.disable();
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
    );
  });

  const oneHit = [
    { chunkId: "c1", docId: "d1", docName: "doc1", text: "t", section: "s", vecScore: 0.9 },
  ];
  const spanByName = (name: string) =>
    exporter.getFinishedSpans().find((s) => s.name === name);

  it("writes independent degradation attributes as booleans", async () => {
    const { chunks, models, kbs } = makeDeps({ vecRows: oneHit, kwFails: true, rerankFails: true });
    await new PgHybridRetriever(chunks, models, kbs).retrieve({
      ...baseReq,
      threshold: 0,
      rerankModelId: "rk1",
    });
    const parent = spanByName("retrieval.retrieve")!;
    expect(parent.attributes["rag.degraded.keyword_recall"]).toBe(true);
    expect(parent.attributes["rag.degraded.rerank"]).toBe(true);
  });

  it("rerank 开启 → retrieve 下挂 embedding + rerank 子 span", async () => {
    const { chunks, models, kbs } = makeDeps({ vecRows: oneHit, rerankResults: [{ index: 0, score: 0.95 }] });
    await new PgHybridRetriever(chunks, models, kbs).retrieve({
      ...baseReq,
      multi: false,
      rerankModelId: "rk1",
    });
    const parent = spanByName("retrieval.retrieve")!;
    const embed = spanByName("retrieval.embedding")!;
    const rerank = spanByName("retrieval.rerank")!;
    expect(parent).toBeDefined();
    expect(embed.parentSpanId).toBe(parent.spanContext().spanId);
    expect(rerank.parentSpanId).toBe(parent.spanContext().spanId);
  });

  it("rerank 失败 → rerank span ERROR，父检索照常降级返回融合分", async () => {
    const { chunks, models, kbs } = makeDeps({ vecRows: oneHit, rerankFails: true });
    const hits = await new PgHybridRetriever(chunks, models, kbs).retrieve({
      ...baseReq,
      multi: false,
      rerankModelId: "rk1",
    });
    expect(hits[0].finalScore).toBe(0.9); // 融合分保留
    expect(spanByName("retrieval.rerank")!.status.code).toBe(2); // SpanStatusCode.ERROR
  });

  it("rerank 未开启 → 无 rerank 子 span", async () => {
    const { chunks, models, kbs } = makeDeps({ vecRows: oneHit });
    await new PgHybridRetriever(chunks, models, kbs).retrieve({ ...baseReq, multi: false });
    expect(spanByName("retrieval.rerank")).toBeUndefined();
    expect(spanByName("retrieval.embedding")).toBeDefined();
  });

  it("retrieve span 带 rag.chunk.scores JSON（未跑的路为 null）", async () => {
    const { chunks, models, kbs } = makeDeps({ vecRows: oneHit });
    await new PgHybridRetriever(chunks, models, kbs).retrieve({ ...baseReq, multi: false });
    const parent = spanByName("retrieval.retrieve")!;
    expect(JSON.parse(parent.attributes["rag.chunk.scores"] as string)).toEqual([
      // M9 W2 D1：加 doc/section（命中分表文档名）
      { chunkId: "c1", doc: "doc1", section: "s", vec: 0.9, kw: null, rerank: null, final: 0.9 },
    ]);
  });

  it("embed 失败 → embedding span ERROR，检索硬失败上抛（向量核心信号）", async () => {
    const { chunks, models, kbs } = makeDeps({ embedFails: true });
    await expect(
      new PgHybridRetriever(chunks, models, kbs).retrieve({ ...baseReq, multi: false }),
    ).rejects.toThrow();
    expect(spanByName("retrieval.embedding")!.status.code).toBe(2); // SpanStatusCode.ERROR
  });
});
