import { OpenAiCompatAdapter } from "../src/modules/models/adapters/openai-compat.adapter";
import type { ModelCallConfig } from "../src/modules/models/ports/model-provider.port";

const cfg = (over: Partial<ModelCallConfig> = {}): ModelCallConfig => ({
  type: "llm",
  provider: "DeepSeek",
  name: "deepseek-chat",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "sk-test12345678",
  ...over,
});

const okJson = (json: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => json }) as unknown as Response;

describe("OpenAiCompatAdapter.testConnection", () => {
  const adapter = new OpenAiCompatAdapter();
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("llm → POST {base}/chat/completions，body 含 max_tokens:1，2xx+choices → ok:true", async () => {
    fetchMock.mockResolvedValue(okJson({ choices: [] }));
    const r = await adapter.testConnection(cfg());
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.deepseek.com/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ model: "deepseek-chat", max_tokens: 1 });
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test12345678");
    expect(r).toMatchObject({ ok: true, statusCode: 200 });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("model 参数取 deploymentId ?? name", async () => {
    fetchMock.mockResolvedValue(okJson({ choices: [] }));
    await adapter.testConnection(cfg({ deploymentId: "my-deploy" }));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBe("my-deploy");
  });

  it("embedding → /embeddings，2xx 且 data[0].embedding 为数组才 ok", async () => {
    fetchMock.mockResolvedValue(okJson({ data: [{ embedding: [0.1] }] }));
    const r = await adapter.testConnection(
      cfg({ type: "embedding", baseUrl: "http://infra.internal:8080" }),
    );
    expect(fetchMock.mock.calls[0][0]).toBe("http://infra.internal:8080/embeddings");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ input: "ping" });
    expect(r.ok).toBe(true);
  });

  it("rerank → /rerank，body 含 query+documents+top_n；results 或 data 数组 → ok", async () => {
    fetchMock.mockResolvedValue(okJson({ results: [] }));
    const r = await adapter.testConnection(
      cfg({ type: "rerank", baseUrl: "http://infra.internal:8080" }),
    );
    expect(fetchMock.mock.calls[0][0]).toBe("http://infra.internal:8080/rerank");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ query: "ping", documents: ["ping", "pong"], top_n: 1 });
    expect(r.ok).toBe(true);
  });

  it("baseUrl 已含 canonical 后缀 → 不重复拼接；尾斜杠归一化", async () => {
    fetchMock.mockResolvedValue(okJson({ results: [] }));
    await adapter.testConnection(cfg({ type: "rerank", baseUrl: "http://infra.internal:8080/rerank" }));
    expect(fetchMock.mock.calls[0][0]).toBe("http://infra.internal:8080/rerank");
    fetchMock.mockResolvedValue(okJson({ choices: [] }));
    await adapter.testConnection(cfg({ baseUrl: "https://api.deepseek.com/v1/" }));
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.deepseek.com/v1/chat/completions");
  });

  it("2xx 但形状不符 → ok:false", async () => {
    fetchMock.mockResolvedValue(okJson({ unexpected: true }));
    const r = await adapter.testConnection(cfg());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/shape/);
  });

  it("非 2xx → ok:false + statusCode + 脱敏 error（不含 apiKey）", async () => {
    fetchMock.mockResolvedValue(okJson({ error: { message: "Invalid API key" } }, 401));
    const r = await adapter.testConnection(cfg());
    expect(r).toMatchObject({ ok: false, statusCode: 401 });
    expect(r.error).toContain("401");
    expect(r.error).not.toContain("sk-test12345678");
  });

  it("网络错误（fetch reject）→ ok:false 不抛", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await adapter.testConnection(cfg());
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ECONNREFUSED");
  });
});
