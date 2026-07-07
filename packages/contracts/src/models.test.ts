import { describe, expect, it } from "vitest";
import {
  CreateModelRequestSchema,
  ModelProviderSchema,
  PROTOCOLS_BY_TYPE,
  TestModelRequestSchema,
  TestModelResponseSchema,
  UpdateModelRequestSchema,
} from "./index";

const validCreate = {
  type: "llm",
  protocol: "openai_compat",
  name: "deepseek-chat",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "sk-test12345678",
};

describe("M3 model contracts (协议化)", () => {
  it("CreateModelRequestSchema 接受合法体且 enabled 缺省 true、params 缺省 {}", () => {
    const r = CreateModelRequestSchema.parse(validCreate);
    expect(r.enabled).toBe(true);
    expect(r.params).toEqual({});
    expect(r.apiKey).toBe("sk-test12345678");
  });
  it("CreateModelRequestSchema 拒绝缺 apiKey / apiKey<8 / 缺 baseUrl / 缺 protocol", () => {
    const { apiKey: _k, ...noKey } = validCreate;
    void _k;
    expect(() => CreateModelRequestSchema.parse(noKey)).toThrow();
    expect(() => CreateModelRequestSchema.parse({ ...validCreate, apiKey: "short" })).toThrow();
    const { baseUrl: _b, ...noBase } = validCreate;
    void _b;
    expect(() => CreateModelRequestSchema.parse(noBase)).toThrow();
    const { protocol: _p, ...noProto } = validCreate;
    void _p;
    expect(() => CreateModelRequestSchema.parse(noProto)).toThrow();
  });
  it("非法 (type, protocol) 组合 → 拒绝（llm+dashscope / rerank+anthropic）", () => {
    expect(() =>
      CreateModelRequestSchema.parse({ ...validCreate, protocol: "dashscope" }),
    ).toThrow();
    expect(() =>
      CreateModelRequestSchema.parse({ ...validCreate, type: "rerank", protocol: "anthropic" }),
    ).toThrow();
    // 合法组合通过
    expect(
      CreateModelRequestSchema.parse({ ...validCreate, type: "rerank", protocol: "dashscope" })
        .protocol,
    ).toBe("dashscope");
  });
  it("PROTOCOLS_BY_TYPE 覆盖三类且组合数为 3+5+5", () => {
    expect(PROTOCOLS_BY_TYPE.llm).toHaveLength(3);
    expect(PROTOCOLS_BY_TYPE.embedding).toHaveLength(5);
    expect(PROTOCOLS_BY_TYPE.rerank).toHaveLength(5); // 含 openai_compat（/v1/reranks 扁平体）
  });
  it("ModelProviderSchema 要求 apiKeyMasked/params、无 apiKey 字段", () => {
    const read = {
      id: "m1",
      type: "llm",
      protocol: "anthropic",
      name: "claude-sonnet-4",
      baseUrl: "https://api.anthropic.com",
      apiKeyMasked: "sk-****5678",
      params: { temperature: "0.4", max_tokens: "4096" },
      enabled: true,
    };
    expect(ModelProviderSchema.parse(read)).toEqual(read);
    const { apiKeyMasked: _m, ...noMask } = read;
    void _m;
    expect(() => ModelProviderSchema.parse(noMask)).toThrow();
    // 未知键（含 apiKey）被 strip，不进入解析结果
    expect(ModelProviderSchema.parse({ ...read, apiKey: "leak" })).not.toHaveProperty("apiKey");
  });
  it("UpdateModelRequestSchema 全字段可选、apiKey 出现时仍 min(8)、同现 type+protocol 校验组合", () => {
    expect(UpdateModelRequestSchema.parse({})).toEqual({});
    expect(UpdateModelRequestSchema.parse({ enabled: false }).enabled).toBe(false);
    expect(() => UpdateModelRequestSchema.parse({ apiKey: "short" })).toThrow();
    expect(() =>
      UpdateModelRequestSchema.parse({ type: "llm", protocol: "dashscope" }),
    ).toThrow();
    expect(UpdateModelRequestSchema.parse({ params: { top_n: "3" } }).params).toEqual({
      top_n: "3",
    });
  });
  it("TestModelRequestSchema 无 enabled；TestModelResponseSchema 形状", () => {
    const r = TestModelRequestSchema.parse({ ...validCreate, enabled: true });
    expect(r).not.toHaveProperty("enabled");
    expect(TestModelResponseSchema.parse({ ok: false, statusCode: 401, error: "HTTP 401" }).ok).toBe(
      false,
    );
  });
});
