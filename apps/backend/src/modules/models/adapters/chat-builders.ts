import type { ModelProtocol } from "@codecrush/contracts";
import { bearerHeaders, isObj, joinUrl, modelId } from "./protocols/types";
import type {
  ChatMessage,
  ChatOptions,
  ModelCallConfig,
} from "../ports/model-provider.port";

/**
 * 文本 chat 请求描述（M8.0）：builder 是纯函数，只负责按协议构造请求体与
 * 响应文本抽取。fetch / 超时 / 密钥擦除统一在 ProtocolDispatchAdapter.chat()
 * （同 PROBE/EMBED/RERANK_BUILDERS 的分工）。
 *
 * 支持矩阵：三种 LLM 协议 openai_compat / anthropic / gemini。
 * 参数合并优先级：请求 temperature 覆盖模型存量 params.temperature；
 * max token 沿用模型已配置的 params.max_tokens（anthropic 必填，缺省 1024）。
 */
export interface ChatRequestSpec {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** 抽取首个规范文本输出；形状不符返回 undefined（由 adapter 归一为稳定错误） */
  parseText: (json: unknown) => string | undefined;
}

export type ChatBuilder = (
  config: ModelCallConfig,
  messages: ChatMessage[],
  opts: ChatOptions,
) => ChatRequestSpec;

const ANTHROPIC_DEFAULT_MAX_TOKENS = 1024;

// 四个 helper 均 export：Story 2 的 chat-stream-builders.ts 需要 import 复用，
// 避免 request-body 构造逻辑（temperature/maxTokens 合并、system/user 消息
// 读取规则）在两个文件里各写一份而漂移。
export function mergedTemperature(c: ModelCallConfig, opts: ChatOptions): number | undefined {
  if (opts.temperature !== undefined) return opts.temperature;
  const stored = c.params?.temperature;
  if (stored === undefined) return undefined;
  const n = Number(stored);
  return Number.isFinite(n) ? n : undefined;
}

export function storedMaxTokens(c: ModelCallConfig): number | undefined {
  const stored = c.params?.max_tokens;
  if (stored === undefined) return undefined;
  const n = Number(stored);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// assembleMessages() 恒定产出两条消息（system/user），但 node-runtime.service.ts
// 的修复重试路径会在其后追加第二条 user 消息（携带"上次哪里错了"的说明）——
// userContent 必须拼接全部 user 消息而不是只取第一条，否则 anthropic/gemini
// 协议的修复重试会静默丢掉这条追加说明，等价于把同一次请求原样重发一遍
// （review P1：.find() 版本曾导致这个问题，已改回拼接全部 user 消息）。
// systemContent 用 .find 是安全的——assembleMessages() 只产出一条 system 消息，
// 全仓库没有任何调用方会追加第二条。
export function systemContent(messages: ChatMessage[]): string {
  return messages.find((m) => m.role === "system")?.content ?? "";
}

export function userContent(messages: ChatMessage[]): string {
  return messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n\n");
}

export const CHAT_BUILDERS: Partial<Record<ModelProtocol, ChatBuilder>> = {
  openai_compat: (c, messages, opts) => {
    const temperature = mergedTemperature(c, opts);
    const maxTokens = storedMaxTokens(c);
    const so = opts.structuredOutput;
    return {
      url: joinUrl(c.baseUrl, "/chat/completions"),
      headers: bearerHeaders(c.apiKey),
      body: {
        model: modelId(c),
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
        ...(so ? { response_format: { type: "json_schema", json_schema: so } } : {}),
      },
      parseText: (json) => {
        if (!isObj(json) || !Array.isArray(json.choices)) return undefined;
        const first = json.choices[0] as { message?: { content?: unknown } } | undefined;
        const content = first?.message?.content;
        return typeof content === "string" ? content : undefined;
      },
    };
  },
  anthropic: (c, messages, opts) => {
    const temperature = mergedTemperature(c, opts);
    const so = opts.structuredOutput;
    return {
      url: joinUrl(c.baseUrl, "/v1/messages"),
      headers: {
        "x-api-key": c.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: {
        model: modelId(c),
        // anthropic 必填 max_tokens：沿用模型配置，缺省 1024
        max_tokens: storedMaxTokens(c) ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
        system: systemContent(messages),
        messages: [{ role: "user", content: userContent(messages) }],
        ...(temperature !== undefined ? { temperature } : {}),
        ...(so
          ? {
              tool_choice: { type: "tool", name: so.name },
              tools: [{ name: so.name, input_schema: so.schema }],
            }
          : {}),
      },
      parseText: (json) => {
        if (!isObj(json) || !Array.isArray(json.content)) return undefined;
        if (so) {
          const toolUse = (
            json.content as Array<{ type?: unknown; name?: unknown; input?: unknown }>
          ).find((b) => b?.type === "tool_use" && b.name === so.name);
          return toolUse ? JSON.stringify(toolUse.input) : undefined;
        }
        const block = (json.content as Array<{ type?: unknown; text?: unknown }>).find(
          (b) => b?.type === "text" && typeof b.text === "string",
        );
        return block ? (block.text as string) : undefined;
      },
    };
  },
  gemini: (c, messages, opts) => {
    const temperature = mergedTemperature(c, opts);
    const maxTokens = storedMaxTokens(c);
    const so = opts.structuredOutput;
    const generationConfig = {
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
      ...(so ? { responseSchema: so.schema, responseMimeType: "application/json" } : {}),
    };
    return {
      url: joinUrl(c.baseUrl, `/models/${modelId(c)}:generateContent`),
      // 认证用 x-goog-api-key 请求头（同探针）：key 进 URL 会泄漏到日志/代理
      headers: { "x-goog-api-key": c.apiKey, "Content-Type": "application/json" },
      body: {
        system_instruction: { parts: [{ text: systemContent(messages) }] },
        contents: [{ role: "user", parts: [{ text: userContent(messages) }] }],
        ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
      },
      parseText: (json) => {
        if (!isObj(json) || !Array.isArray(json.candidates)) return undefined;
        const first = json.candidates[0] as
          | { content?: { parts?: Array<{ text?: unknown }> } }
          | undefined;
        const parts = first?.content?.parts;
        if (!Array.isArray(parts)) return undefined;
        const text = parts
          .map((p) => (typeof p?.text === "string" ? p.text : ""))
          .join("");
        return text.length > 0 ? text : undefined;
      },
    };
  },
};
