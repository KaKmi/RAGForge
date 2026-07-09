import { PROTOCOLS_BY_TYPE } from "@codecrush/contracts";
import { EMBED_BUILDERS } from "../src/modules/models/adapters/embed-builders";
import type { ModelCallConfig } from "../src/modules/models/ports/model-provider.port";

const cfg = (over: Partial<ModelCallConfig> = {}): ModelCallConfig => ({
  type: "embedding",
  protocol: "openai_compat",
  name: "bge-m3",
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test",
  params: { dimensions: "1024" },
  ...over,
});

describe("EMBED_BUILDERS 表完整性", () => {
  it("每个 embedding 协议都有 builder，覆盖 5 个", () => {
    for (const protocol of PROTOCOLS_BY_TYPE.embedding) {
      expect(EMBED_BUILDERS[protocol]).toBeDefined();
    }
    expect(Object.keys(EMBED_BUILDERS)).toHaveLength(5);
  });
});

describe("openai_compat embed builder", () => {
  it("请求体含 dimensions 与全部文本、响应解析按 data[].embedding 顺序取出", () => {
    const req = EMBED_BUILDERS.openai_compat(cfg(), ["a", "b"]);
    expect(req.url).toBe("https://api.example.com/v1/embeddings");
    expect(req.body).toMatchObject({ model: "bge-m3", input: ["a", "b"], dimensions: 1024 });
    const vectors = req.parseResponse({
      data: [{ embedding: [1, 2] }, { embedding: [3, 4] }],
    });
    expect(vectors).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("data 乱序返回（带 index）时按 index 对齐输入文本顺序", () => {
    const req = EMBED_BUILDERS.openai_compat(cfg(), ["t0", "t1"]);
    const vectors = req.parseResponse({
      data: [
        { index: 1, embedding: [3, 4] },
        { index: 0, embedding: [1, 2] },
      ],
    });
    expect(vectors).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });
});

describe("jina embed builder", () => {
  it("data 乱序返回（带 index）时按 index 对齐输入文本顺序", () => {
    const req = EMBED_BUILDERS.jina(cfg({ protocol: "jina" }), ["t0", "t1"]);
    const vectors = req.parseResponse({
      data: [
        { index: 1, embedding: [3, 4] },
        { index: 0, embedding: [1, 2] },
      ],
    });
    expect(vectors).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });
});

describe("self_hosted (TEI) embed builder", () => {
  it("响应是顶层数组，直接透传为 vectors", () => {
    const req = EMBED_BUILDERS.self_hosted(cfg({ protocol: "self_hosted" }), ["a"]);
    expect(req.body).toEqual({ inputs: ["a"] });
    expect(req.parseResponse([[0.1, 0.2]])).toEqual([[0.1, 0.2]]);
  });
});
