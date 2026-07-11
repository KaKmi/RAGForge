import { CHAT_BUILDERS } from "../src/modules/models/adapters/chat-builders";
import type { ModelCallConfig } from "../src/modules/models/ports/model-provider.port";

// 012 Story 7：三协议 chat builder 的请求构造与文本抽取（最小支持矩阵，drill 收口）

const base = (over: Partial<ModelCallConfig> = {}): ModelCallConfig => ({
  type: "llm",
  protocol: "openai_compat",
  name: "test-model",
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-secret",
  ...over,
});

const input = { system: "你是回复生成器：问题 {q}", user: "怎么退货" };

describe("CHAT_BUILDERS · openai_compat", () => {
  it("构造 /chat/completions：system+user 两条消息 + Bearer 认证", () => {
    const req = CHAT_BUILDERS.openai_compat!(base(), input, {});
    expect(req.url).toBe("https://api.example.com/v1/chat/completions");
    expect(req.headers.Authorization).toBe("Bearer sk-secret");
    const body = req.body as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      temperature?: number;
    };
    expect(body.model).toBe("test-model");
    expect(body.messages).toEqual([
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ]);
    expect(body.temperature).toBeUndefined();
  });

  it("请求 temperature 覆盖模型存量默认；未传时用存量 params.temperature", () => {
    const stored = base({ params: { temperature: "0.3", max_tokens: "512" } });
    const withOverride = CHAT_BUILDERS.openai_compat!(stored, input, { temperature: 1.5 })
      .body as { temperature: number; max_tokens: number };
    expect(withOverride.temperature).toBe(1.5);
    expect(withOverride.max_tokens).toBe(512); // max token 沿用模型配置，不受请求影响
    const withStored = CHAT_BUILDERS.openai_compat!(stored, input, {}).body as {
      temperature: number;
    };
    expect(withStored.temperature).toBe(0.3);
  });

  it("parseText 抽 choices[0].message.content；形状不符返回 undefined", () => {
    const req = CHAT_BUILDERS.openai_compat!(base(), input, {});
    expect(req.parseText({ choices: [{ message: { content: "好的" } }] })).toBe("好的");
    expect(req.parseText({ choices: [] })).toBeUndefined();
    expect(req.parseText({ choices: [{ message: { content: null } }] })).toBeUndefined();
    expect(req.parseText("nope")).toBeUndefined();
  });
});

describe("CHAT_BUILDERS · anthropic", () => {
  it("构造 /v1/messages：x-api-key + anthropic-version，system 独立字段，max_tokens 必填缺省 1024", () => {
    const req = CHAT_BUILDERS.anthropic!(base({ protocol: "anthropic" }), input, {});
    expect(req.url).toBe("https://api.example.com/v1/v1/messages");
    expect(req.headers["x-api-key"]).toBe("sk-secret");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    const body = req.body as {
      system: string;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.system).toBe(input.system);
    expect(body.max_tokens).toBe(1024);
    expect(body.messages).toEqual([{ role: "user", content: input.user }]);
  });

  it("存量 max_tokens 沿用；temperature 覆盖优先", () => {
    const c = base({ protocol: "anthropic", params: { max_tokens: "2048", temperature: "0.2" } });
    const body = CHAT_BUILDERS.anthropic!(c, input, { temperature: 0.9 }).body as {
      max_tokens: number;
      temperature: number;
    };
    expect(body.max_tokens).toBe(2048);
    expect(body.temperature).toBe(0.9);
  });

  it("parseText 抽第一个 text block；无 text block 返回 undefined", () => {
    const req = CHAT_BUILDERS.anthropic!(base({ protocol: "anthropic" }), input, {});
    expect(
      req.parseText({ content: [{ type: "thinking" }, { type: "text", text: "回答" }] }),
    ).toBe("回答");
    expect(req.parseText({ content: [{ type: "tool_use" }] })).toBeUndefined();
    expect(req.parseText({})).toBeUndefined();
  });
});

describe("CHAT_BUILDERS · gemini", () => {
  it("构造 :generateContent：x-goog-api-key 头（key 不进 URL），system_instruction 独立", () => {
    const req = CHAT_BUILDERS.gemini!(base({ protocol: "gemini" }), input, { temperature: 0.5 });
    expect(req.url).toBe("https://api.example.com/v1/models/test-model:generateContent");
    expect(req.url).not.toContain("sk-secret");
    expect(req.headers["x-goog-api-key"]).toBe("sk-secret");
    const body = req.body as {
      system_instruction: { parts: Array<{ text: string }> };
      contents: Array<{ role: string; parts: Array<{ text: string }> }>;
      generationConfig: { temperature: number };
    };
    expect(body.system_instruction.parts[0].text).toBe(input.system);
    expect(body.contents[0]).toEqual({ role: "user", parts: [{ text: input.user }] });
    expect(body.generationConfig.temperature).toBe(0.5);
  });

  it("存量 max_tokens → generationConfig.maxOutputTokens", () => {
    const c = base({ protocol: "gemini", params: { max_tokens: "800" } });
    const body = CHAT_BUILDERS.gemini!(c, input, {}).body as {
      generationConfig: { maxOutputTokens: number };
    };
    expect(body.generationConfig.maxOutputTokens).toBe(800);
  });

  it("parseText 拼接 candidates[0].content.parts[].text；空输出返回 undefined", () => {
    const req = CHAT_BUILDERS.gemini!(base({ protocol: "gemini" }), input, {});
    expect(
      req.parseText({
        candidates: [{ content: { parts: [{ text: "第一段" }, { text: "第二段" }] } }],
      }),
    ).toBe("第一段第二段");
    expect(req.parseText({ candidates: [{ content: { parts: [] } }] })).toBeUndefined();
    expect(req.parseText({ candidates: [] })).toBeUndefined();
  });
});

describe("CHAT_BUILDERS · 支持矩阵", () => {
  it("恰好覆盖三种 LLM 协议（与契约 TRY_RUN_CHAT_PROTOCOLS 对齐）", () => {
    expect(Object.keys(CHAT_BUILDERS).sort()).toEqual(["anthropic", "gemini", "openai_compat"]);
  });

  it("deploymentId 优先于 name 作为 model id（同探针语义）", () => {
    const c = base({ deploymentId: "deploy-42" });
    const body = CHAT_BUILDERS.openai_compat!(c, input, {}).body as { model: string };
    expect(body.model).toBe("deploy-42");
  });
});
