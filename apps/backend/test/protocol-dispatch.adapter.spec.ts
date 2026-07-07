import { PROTOCOLS_BY_TYPE, type ModelType } from "@codecrush/contracts";
import {
  PROBE_BUILDERS,
  ProtocolDispatchAdapter,
} from "../src/modules/models/adapters/protocol-dispatch.adapter";
import type { ModelCallConfig } from "../src/modules/models/ports/model-provider.port";

const cfg = (over: Partial<ModelCallConfig> = {}): ModelCallConfig => ({
  type: "llm",
  protocol: "openai_compat",
  name: "deepseek-chat",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "sk-test12345678",
  ...over,
});

const okJson = (json: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => json }) as unknown as Response;

const lastCall = (m: jest.Mock) => {
  const [url, init] = m.mock.calls[m.mock.calls.length - 1] as [string, RequestInit];
  return { url, init, body: JSON.parse(init.body as string) as Record<string, unknown>, headers: init.headers as Record<string, string> };
};

describe("PROBE_BUILDERS 表完整性", () => {
  it("契约 PROTOCOLS_BY_TYPE 的每个合法组合都有 builder", () => {
    for (const type of Object.keys(PROTOCOLS_BY_TYPE) as ModelType[]) {
      for (const protocol of PROTOCOLS_BY_TYPE[type]) {
        expect(PROBE_BUILDERS[`${type}:${protocol}`]).toBeDefined();
      }
    }
    // 表里也没有多余项（13 = 3+5+5）
    expect(Object.keys(PROBE_BUILDERS)).toHaveLength(13);
  });
});

describe("ProtocolDispatchAdapter.testConnection", () => {
  const adapter = new ProtocolDispatchAdapter();
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("llm+openai_compat → /chat/completions，Bearer，max_tokens:1，choices → ok", async () => {
    fetchMock.mockResolvedValue(okJson({ choices: [] }));
    const r = await adapter.testConnection(cfg());
    const { url, body, headers } = lastCall(fetchMock);
    expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(body).toMatchObject({ model: "deepseek-chat", max_tokens: 1 });
    expect(headers.Authorization).toBe("Bearer sk-test12345678");
    expect(r).toMatchObject({ ok: true, statusCode: 200 });
  });

  it("llm+anthropic → /v1/messages，x-api-key + anthropic-version，content → ok", async () => {
    fetchMock.mockResolvedValue(okJson({ content: [] }));
    const r = await adapter.testConnection(
      cfg({ protocol: "anthropic", baseUrl: "https://api.anthropic.com", name: "claude-sonnet-4" }),
    );
    const { url, body, headers } = lastCall(fetchMock);
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(body).toMatchObject({ model: "claude-sonnet-4", max_tokens: 1 });
    expect(headers["x-api-key"]).toBe("sk-test12345678");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers.Authorization).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  it("llm+gemini → /models/{model}:generateContent，x-goog-api-key 头（key 不进 URL），candidates → ok", async () => {
    fetchMock.mockResolvedValue(okJson({ candidates: [] }));
    const r = await adapter.testConnection(
      cfg({
        protocol: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        name: "gemini-2.0-flash",
      }),
    );
    const { url, headers } = lastCall(fetchMock);
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
    );
    expect(url).not.toContain("sk-test12345678");
    expect(headers["x-goog-api-key"]).toBe("sk-test12345678");
    expect(r.ok).toBe(true);
  });

  it("embedding+self_hosted (TEI) → /embed {inputs}，顶层数组 → ok", async () => {
    fetchMock.mockResolvedValue(okJson([[0.1, 0.2]]));
    const r = await adapter.testConnection(
      cfg({ type: "embedding", protocol: "self_hosted", baseUrl: "http://infra.internal:8080", name: "bge-m3" }),
    );
    const { url, body } = lastCall(fetchMock);
    expect(url).toBe("http://infra.internal:8080/embed");
    expect(body).toMatchObject({ inputs: ["ping"] });
    expect(r.ok).toBe(true);
  });

  it("embedding+openai_compat → /embeddings，data[0].embedding → ok；形状不符 → ok:false", async () => {
    fetchMock.mockResolvedValue(okJson({ data: [{ embedding: [0.1] }] }));
    const r1 = await adapter.testConnection(
      cfg({ type: "embedding", protocol: "openai_compat", name: "text-embedding-3-large" }),
    );
    expect(lastCall(fetchMock).url).toBe("https://api.deepseek.com/v1/embeddings");
    expect(r1.ok).toBe(true);
    fetchMock.mockResolvedValue(okJson({ unexpected: true }));
    const r2 = await adapter.testConnection(
      cfg({ type: "embedding", protocol: "openai_compat", name: "text-embedding-3-large" }),
    );
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/shape/);
  });

  it("rerank+self_hosted：base 已含 /rerank 不重复拼；TEI {query,texts}", async () => {
    fetchMock.mockResolvedValue(okJson([{ index: 0, score: 0.9 }]));
    const r = await adapter.testConnection(
      cfg({ type: "rerank", protocol: "self_hosted", baseUrl: "http://infra.internal:8080/rerank", name: "bge-reranker-v2-m3" }),
    );
    const { url, body } = lastCall(fetchMock);
    expect(url).toBe("http://infra.internal:8080/rerank");
    expect(body).toMatchObject({ query: "ping", texts: ["ping", "pong"] });
    expect(r.ok).toBe(true);
  });

  it("rerank+openai_compat → /reranks 扁平体（阿里云 compatible-api 形态）", async () => {
    fetchMock.mockResolvedValue(okJson({ results: [] }));
    const r = await adapter.testConnection(
      cfg({
        type: "rerank",
        protocol: "openai_compat",
        baseUrl: "https://ws-123.cn-beijing.maas.aliyuncs.com/compatible-api/v1",
        name: "qwen3-rerank",
      }),
    );
    const { url, body } = lastCall(fetchMock);
    expect(url).toBe("https://ws-123.cn-beijing.maas.aliyuncs.com/compatible-api/v1/reranks");
    expect(body).toMatchObject({ model: "qwen3-rerank", query: "ping", documents: ["ping", "pong"], top_n: 1 });
    expect(r.ok).toBe(true);
  });

  it("rerank+dashscope → /services/rerank/text-rerank/text-rerank，output.results → ok", async () => {
    fetchMock.mockResolvedValue(okJson({ output: { results: [] } }));
    const r = await adapter.testConnection(
      cfg({ type: "rerank", protocol: "dashscope", baseUrl: "https://dashscope.aliyuncs.com/api/v1", name: "gte-rerank" }),
    );
    expect(lastCall(fetchMock).url).toBe(
      "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank",
    );
    expect(r.ok).toBe(true);
  });

  it("model 参数取 deploymentId ?? name", async () => {
    fetchMock.mockResolvedValue(okJson({ choices: [] }));
    await adapter.testConnection(cfg({ deploymentId: "my-deploy" }));
    expect(lastCall(fetchMock).body.model).toBe("my-deploy");
  });

  it("非 2xx → ok:false + statusCode + 脱敏；上游回显 key → 擦除", async () => {
    fetchMock.mockResolvedValue(
      okJson({ error: { message: "Invalid API key sk-test12345678 provided" } }, 401),
    );
    const r = await adapter.testConnection(cfg());
    expect(r).toMatchObject({ ok: false, statusCode: 401 });
    expect(r.error).toContain("401");
    expect(r.error).not.toContain("sk-test12345678");
    expect(r.error).toContain("[REDACTED]");
  });

  it("网络错误（fetch reject）→ ok:false 不抛", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await adapter.testConnection(cfg());
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ECONNREFUSED");
  });
});
