import { PROTOCOLS_BY_TYPE } from "@codecrush/contracts";
import { RERANK_BUILDERS } from "../src/modules/models/adapters/rerank-builders";
import type { ModelCallConfig } from "../src/modules/models/ports/model-provider.port";

const cfg = (over: Partial<ModelCallConfig> = {}): ModelCallConfig => ({
  type: "rerank",
  protocol: "cohere",
  name: "rerank-v3",
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test",
  params: {},
  ...over,
});

describe("RERANK_BUILDERS 表完整性", () => {
  it("每个 rerank 协议都有 builder，覆盖 5 个", () => {
    for (const protocol of PROTOCOLS_BY_TYPE.rerank) {
      expect(RERANK_BUILDERS[protocol]).toBeDefined();
    }
    expect(Object.keys(RERANK_BUILDERS)).toHaveLength(5);
  });
});

describe("cohere/jina rerank builder", () => {
  it("请求体含 query/documents/top_n，响应按 results[].relevance_score 解析", () => {
    const req = RERANK_BUILDERS.cohere(cfg(), "问题", ["文档A", "文档B"], 2);
    expect(req.url).toBe("https://api.example.com/v1/rerank");
    expect(req.body).toMatchObject({
      model: "rerank-v3",
      query: "问题",
      documents: ["文档A", "文档B"],
      top_n: 2,
    });
    expect(
      req.parseResponse({
        results: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.3 },
        ],
      }),
    ).toEqual([
      { index: 1, score: 0.9 },
      { index: 0, score: 0.3 },
    ]);
  });
});

describe("openai_compat rerank builder", () => {
  it("URL 是 /reranks，兼容 results 或 data 两种响应包裹字段", () => {
    const req = RERANK_BUILDERS.openai_compat(cfg({ protocol: "openai_compat" }), "q", ["a", "b"]);
    expect(req.url).toBe("https://api.example.com/v1/reranks");
    expect(req.parseResponse({ results: [{ index: 0, relevance_score: 0.5 }] })).toEqual([
      { index: 0, score: 0.5 },
    ]);
    expect(req.parseResponse({ data: [{ index: 0, relevance_score: 0.7 }] })).toEqual([
      { index: 0, score: 0.7 },
    ]);
  });
});

describe("dashscope rerank builder", () => {
  it("URL 是 text-rerank 端点，body 用 input/parameters 包裹，响应从 output.results 取", () => {
    const req = RERANK_BUILDERS.dashscope(cfg({ protocol: "dashscope" }), "q", ["a", "b"], 1);
    expect(req.url).toBe("https://api.example.com/v1/services/rerank/text-rerank/text-rerank");
    expect(req.body).toEqual({
      model: "rerank-v3",
      input: { query: "q", documents: ["a", "b"] },
      parameters: { top_n: 1 },
    });
    expect(
      req.parseResponse({ output: { results: [{ index: 0, relevance_score: 0.6 }] } }),
    ).toEqual([{ index: 0, score: 0.6 }]);
  });
});

describe("self_hosted (TEI) rerank builder", () => {
  it("body 是 {query, texts}，响应是顶层数组 [{index, score}]", () => {
    const req = RERANK_BUILDERS.self_hosted(cfg({ protocol: "self_hosted" }), "q", ["a"]);
    expect(req.body).toEqual({ query: "q", texts: ["a"] });
    expect(req.parseResponse([{ index: 0, score: 0.42 }])).toEqual([{ index: 0, score: 0.42 }]);
  });
});
