import type { ModelProtocol } from "@codecrush/contracts";
import { bearerHeaders, isObj, joinUrl, modelId } from "./protocols/types";
import type { ModelCallConfig } from "../ports/model-provider.port";

/**
 * 文本 chat 请求描述（012 Story 7 试运行）：builder 是纯函数，只负责按协议构造请求体
 * 与响应文本抽取。fetch / 60s 超时 / 密钥擦除统一在 ProtocolDispatchAdapter.chat()
 * （同 PROBE/EMBED/RERANK_BUILDERS 的分工）。
 *
 * 支持矩阵（drill 收口）：当前全部三种 LLM 协议 openai_compat / anthropic / gemini。
 * 参数合并优先级：请求 temperature 覆盖模型存量 params.temperature；
 * max token 沿用模型已配置的 params.max_tokens（anthropic 必填，缺省 1024）。
 */
export interface ChatInput {
  /** 平台组装的 system 指令（渲染后的 Prompt 正文） */
  system: string;
  /** 用户消息（试运行的 query） */
  user: string;
}

export interface ChatCallOptions {
  temperature?: number;
}

export interface ChatRequestSpec {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** 抽取首个规范文本输出；形状不符返回 undefined（由 adapter 归一为稳定错误） */
  parseText: (json: unknown) => string | undefined;
}

export type ChatBuilder = (
  config: ModelCallConfig,
  input: ChatInput,
  opts: ChatCallOptions,
) => ChatRequestSpec;

const ANTHROPIC_DEFAULT_MAX_TOKENS = 1024;

function mergedTemperature(c: ModelCallConfig, opts: ChatCallOptions): number | undefined {
  if (opts.temperature !== undefined) return opts.temperature;
  const stored = c.params?.temperature;
  if (stored === undefined) return undefined;
  const n = Number(stored);
  return Number.isFinite(n) ? n : undefined;
}

function storedMaxTokens(c: ModelCallConfig): number | undefined {
  const stored = c.params?.max_tokens;
  if (stored === undefined) return undefined;
  const n = Number(stored);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// (protocol) → chat builder 表：仅 LLM 三协议（契约 TRY_RUN_CHAT_PROTOCOLS 同一矩阵）。
// 其余协议查不到 builder：调用方（prompts try-run）已按契约矩阵返回 unavailable，
// adapter 的防御分支兜底抛错（正常不可达）。
export const CHAT_BUILDERS: Partial<Record<ModelProtocol, ChatBuilder>> = {
  openai_compat: (c, input, opts) => {
    const temperature = mergedTemperature(c, opts);
    const maxTokens = storedMaxTokens(c);
    return {
      url: joinUrl(c.baseUrl, "/chat/completions"),
      headers: bearerHeaders(c.apiKey),
      body: {
        model: modelId(c),
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      },
      parseText: (json) => {
        if (!isObj(json) || !Array.isArray(json.choices)) return undefined;
        const first = json.choices[0] as { message?: { content?: unknown } } | undefined;
        const content = first?.message?.content;
        return typeof content === "string" ? content : undefined;
      },
    };
  },
  anthropic: (c, input, opts) => {
    const temperature = mergedTemperature(c, opts);
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
        system: input.system,
        messages: [{ role: "user", content: input.user }],
        ...(temperature !== undefined ? { temperature } : {}),
      },
      parseText: (json) => {
        if (!isObj(json) || !Array.isArray(json.content)) return undefined;
        const block = (json.content as Array<{ type?: unknown; text?: unknown }>).find(
          (b) => b?.type === "text" && typeof b.text === "string",
        );
        return block ? (block.text as string) : undefined;
      },
    };
  },
  gemini: (c, input, opts) => {
    const temperature = mergedTemperature(c, opts);
    const maxTokens = storedMaxTokens(c);
    const generationConfig = {
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
    };
    return {
      url: joinUrl(c.baseUrl, `/models/${modelId(c)}:generateContent`),
      // 认证用 x-goog-api-key 请求头（同探针）：key 进 URL 会泄漏到日志/代理
      headers: { "x-goog-api-key": c.apiKey, "Content-Type": "application/json" },
      body: {
        system_instruction: { parts: [{ text: input.system }] },
        contents: [{ role: "user", parts: [{ text: input.user }] }],
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
