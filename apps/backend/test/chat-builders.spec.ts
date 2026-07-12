import { CHAT_BUILDERS } from "../src/modules/models/adapters/chat-builders";
import type {
  ChatMessage,
  ModelCallConfig,
  StructuredOutputSpec,
} from "../src/modules/models/ports/model-provider.port";

// M8.0：三协议 chat builder 支持 system/user 两层消息 + 结构化输出注入
// （覆盖矩阵、温度/max_tokens 合并、deploymentId 优先级等既有断言原样保留）。

const base = (over: Partial<ModelCallConfig> = {}): ModelCallConfig => ({
  type: "llm",
  protocol: "openai_compat",
  name: "test-model",
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-secret",
  ...over,
});

const messages: ChatMessage[] = [
  { role: "system", content: "固定 system" },
  { role: "user", content: '{"query":"q"}' },
];

// review P1：node-runtime.service.ts 的修复重试路径会在 assembleMessages() 的两条
// 消息之后再追加一条 user 消息（见 executeStructured 的 repairMessages），复现这个
// 三条消息、两条 user 的形状——userContent 必须拼接全部 user 消息，不能只取第一条，
// 否则 anthropic/gemini 会静默丢掉这条"上次哪里错了"的说明，等价于原样重发请求。
const repairMessages: ChatMessage[] = [
  ...messages,
  { role: "user", content: "上一次输出未通过校验：xxx。请重新输出。" },
];

const structuredOutput: StructuredOutputSpec = {
  name: "rewrite_v1",
  schema: { type: "object", properties: { rewrittenQuery: { type: "string" } }, required: ["rewrittenQuery"] },
  strict: true,
};

describe("CHAT_BUILDERS · openai_compat", () => {
  it("两条消息原样映射为 messages 数组（system/user 角色透传）+ Bearer 认证", () => {
    const req = CHAT_BUILDERS.openai_compat!(base(), messages, {});
    expect(req.url).toBe("https://api.example.com/v1/chat/completions");
    expect(req.headers.Authorization).toBe("Bearer sk-secret");
    const body = req.body as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      temperature?: number;
    };
    expect(body.model).toBe("test-model");
    expect(body.messages).toEqual([
      { role: "system", content: "固定 system" },
      { role: "user", content: '{"query":"q"}' },
    ]);
    expect(body.temperature).toBeUndefined();
  });

  it("请求 temperature 覆盖模型存量默认；未传时用存量 params.temperature", () => {
    const stored = base({ params: { temperature: "0.3", max_tokens: "512" } });
    const withOverride = CHAT_BUILDERS.openai_compat!(stored, messages, { temperature: 1.5 })
      .body as { temperature: number; max_tokens: number };
    expect(withOverride.temperature).toBe(1.5);
    expect(withOverride.max_tokens).toBe(512); // max token 沿用模型配置，不受请求影响
    const withStored = CHAT_BUILDERS.openai_compat!(stored, messages, {}).body as {
      temperature: number;
    };
    expect(withStored.temperature).toBe(0.3);
  });

  it("带 structuredOutput 时注入 response_format json_schema", () => {
    const req = CHAT_BUILDERS.openai_compat!(base(), messages, { structuredOutput });
    const body = req.body as { response_format: unknown };
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "rewrite_v1", schema: structuredOutput.schema, strict: true },
    });
  });

  it("不带 structuredOutput 时不出现 response_format 字段", () => {
    const req = CHAT_BUILDERS.openai_compat!(base(), messages, {});
    expect(req.body as object).not.toHaveProperty("response_format");
  });

  it("parseText 抽 choices[0].message.content；形状不符返回 undefined", () => {
    const req = CHAT_BUILDERS.openai_compat!(base(), messages, {});
    expect(req.parseText({ choices: [{ message: { content: "好的" } }] })).toBe("好的");
    expect(req.parseText({ choices: [] })).toBeUndefined();
    expect(req.parseText({ choices: [{ message: { content: null } }] })).toBeUndefined();
    expect(req.parseText("nope")).toBeUndefined();
  });

  it("parseText：带 structuredOutput 仍读 message.content（json_schema 走标准 content 字段，非 tool_use）", () => {
    const req = CHAT_BUILDERS.openai_compat!(base(), messages, { structuredOutput });
    expect(req.parseText({ choices: [{ message: { content: '{"rewrittenQuery":"x"}' } }] })).toBe(
      '{"rewrittenQuery":"x"}',
    );
  });
});

describe("CHAT_BUILDERS · anthropic", () => {
  const anthropicConfig = base({ protocol: "anthropic" });

  it("system 角色消息映射到顶层 system 字段，user 消息原样映射（无角色可折叠，两层模型下 messages 只有一条 user）", () => {
    const req = CHAT_BUILDERS.anthropic!(anthropicConfig, messages, {});
    expect(req.url).toBe("https://api.example.com/v1/v1/messages");
    expect(req.headers["x-api-key"]).toBe("sk-secret");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    const body = req.body as {
      system: string;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.system).toBe("固定 system");
    expect(body.max_tokens).toBe(1024);
    expect(body.messages).toEqual([{ role: "user", content: '{"query":"q"}' }]);
  });

  it("修复重试路径（两条 user 消息）：拼接全部 user 消息，不丢修复说明（review P1）", () => {
    const req = CHAT_BUILDERS.anthropic!(anthropicConfig, repairMessages, {});
    const body = req.body as { messages: Array<{ role: string; content: string }> };
    expect(body.messages).toEqual([
      {
        role: "user",
        content: '{"query":"q"}\n\n上一次输出未通过校验：xxx。请重新输出。',
      },
    ]);
  });

  it("存量 max_tokens 沿用；temperature 覆盖优先", () => {
    const c = base({ protocol: "anthropic", params: { max_tokens: "2048", temperature: "0.2" } });
    const body = CHAT_BUILDERS.anthropic!(c, messages, { temperature: 0.9 }).body as {
      max_tokens: number;
      temperature: number;
    };
    expect(body.max_tokens).toBe(2048);
    expect(body.temperature).toBe(0.9);
  });

  it("带 structuredOutput：强制 tool_choice 单一工具，tools 携带 input_schema", () => {
    const req = CHAT_BUILDERS.anthropic!(anthropicConfig, messages, { structuredOutput });
    const body = req.body as {
      tool_choice: unknown;
      tools: Array<{ name: string; input_schema: unknown }>;
    };
    expect(body.tool_choice).toEqual({ type: "tool", name: "rewrite_v1" });
    expect(body.tools).toEqual([{ name: "rewrite_v1", input_schema: structuredOutput.schema }]);
  });

  it("parseText：无 structuredOutput 抽第一个 text block；无 text block 返回 undefined", () => {
    const req = CHAT_BUILDERS.anthropic!(anthropicConfig, messages, {});
    expect(
      req.parseText({ content: [{ type: "thinking" }, { type: "text", text: "回答" }] }),
    ).toBe("回答");
    expect(req.parseText({ content: [{ type: "tool_use" }] })).toBeUndefined();
    expect(req.parseText({})).toBeUndefined();
  });

  it("parseText：带 structuredOutput 读 tool_use block 的 input（非 text block）", () => {
    const req = CHAT_BUILDERS.anthropic!(anthropicConfig, messages, { structuredOutput });
    const text = req.parseText({
      content: [{ type: "tool_use", name: "rewrite_v1", input: { rewrittenQuery: "x" } }],
    });
    expect(text).toBe('{"rewrittenQuery":"x"}');
  });
});

describe("CHAT_BUILDERS · gemini", () => {
  const geminiConfig = base({ protocol: "gemini" });

  it("system 角色映射 system_instruction，user parts 原样映射（x-goog-api-key 头，key 不进 URL）", () => {
    const req = CHAT_BUILDERS.gemini!(geminiConfig, messages, { temperature: 0.5 });
    expect(req.url).toBe("https://api.example.com/v1/models/test-model:generateContent");
    expect(req.url).not.toContain("sk-secret");
    expect(req.headers["x-goog-api-key"]).toBe("sk-secret");
    const body = req.body as {
      system_instruction: { parts: Array<{ text: string }> };
      contents: Array<{ role: string; parts: Array<{ text: string }> }>;
      generationConfig: { temperature: number };
    };
    expect(body.system_instruction.parts[0].text).toBe("固定 system");
    expect(body.contents[0].parts[0].text).toBe('{"query":"q"}');
    expect(body.generationConfig.temperature).toBe(0.5);
  });

  it("修复重试路径（两条 user 消息）：拼接全部 user 消息，不丢修复说明（review P1）", () => {
    const req = CHAT_BUILDERS.gemini!(geminiConfig, repairMessages, {});
    const body = req.body as { contents: Array<{ parts: Array<{ text: string }> }> };
    expect(body.contents[0].parts[0].text).toBe(
      '{"query":"q"}\n\n上一次输出未通过校验：xxx。请重新输出。',
    );
  });

  it("存量 max_tokens → generationConfig.maxOutputTokens", () => {
    const c = base({ protocol: "gemini", params: { max_tokens: "800" } });
    const body = CHAT_BUILDERS.gemini!(c, messages, {}).body as {
      generationConfig: { maxOutputTokens: number };
    };
    expect(body.generationConfig.maxOutputTokens).toBe(800);
  });

  it("带 structuredOutput：generationConfig.responseSchema + responseMimeType", () => {
    const req = CHAT_BUILDERS.gemini!(geminiConfig, messages, { structuredOutput });
    const body = req.body as {
      generationConfig: { responseSchema: unknown; responseMimeType: string };
    };
    expect(body.generationConfig.responseSchema).toEqual(structuredOutput.schema);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
  });

  it("parseText 拼接 candidates[0].content.parts[].text；空输出返回 undefined", () => {
    const req = CHAT_BUILDERS.gemini!(geminiConfig, messages, {});
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
    const body = CHAT_BUILDERS.openai_compat!(c, messages, {}).body as { model: string };
    expect(body.model).toBe("deploy-42");
  });
});
