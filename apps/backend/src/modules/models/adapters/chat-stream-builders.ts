import type { ModelProtocol } from "@codecrush/contracts";
import { bearerHeaders, isObj, joinUrl, modelId } from "./protocols/types";
import {
  mergeNonSystemMessages,
  systemContent,
  mergedTemperature,
  storedMaxTokens,
} from "./chat-builders";
import type {
  ChatMessage,
  ChatOptions,
  ChatStreamChunk,
  ModelCallConfig,
} from "../ports/model-provider.port";

export interface ChatStreamRequestSpec {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** openai_compat/gemini：逐个已拆分的 JSON 分片字符串（或 "[DONE]"）→ chunk */
  parseChunk: (raw: string) => ChatStreamChunk;
  /** anthropic：SSE event 类型 + data 载荷字符串 → chunk（openai_compat/gemini 不用） */
  parseEvent: (event: string, data: string) => ChatStreamChunk;
}

export type ChatStreamBuilder = (
  config: ModelCallConfig,
  messages: ChatMessage[],
  opts: ChatOptions,
) => ChatStreamRequestSpec;

const noopParseEvent = (): ChatStreamChunk => ({});
const noopParseChunk = (): ChatStreamChunk => ({});

export const CHAT_STREAM_BUILDERS: Partial<Record<ModelProtocol, ChatStreamBuilder>> = {
  openai_compat: (c, messages, opts) => {
    const temperature = mergedTemperature(c, opts);
    const maxTokens = storedMaxTokens(c);
    return {
      url: joinUrl(c.baseUrl, "/chat/completions"),
      headers: bearerHeaders(c.apiKey),
      body: {
        model: modelId(c),
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      },
      parseChunk: (raw) => {
        if (raw.trim() === "[DONE]") return { done: true };
        const json: unknown = JSON.parse(raw);
        if (!isObj(json) || !Array.isArray(json.choices)) return {};
        const delta = (json.choices[0] as { delta?: { content?: unknown } })?.delta?.content;
        return typeof delta === "string" && delta.length > 0 ? { delta } : {};
      },
      parseEvent: noopParseEvent,
    };
  },
  anthropic: (c, messages, opts) => {
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
        max_tokens: storedMaxTokens(c) ?? 1024,
        system: systemContent(messages),
        messages: [{ role: "user", content: mergeNonSystemMessages(messages) }],
        stream: true,
        ...(temperature !== undefined ? { temperature } : {}),
      },
      parseChunk: noopParseChunk,
      parseEvent: (event, data) => {
        if (event === "message_stop") return { done: true };
        if (event !== "content_block_delta") return {};
        const json: unknown = JSON.parse(data);
        if (!isObj(json)) return {};
        const d = json.delta as { type?: unknown; text?: unknown } | undefined;
        return d?.type === "text_delta" && typeof d.text === "string" ? { delta: d.text } : {};
      },
    };
  },
  gemini: (c, messages, opts) => {
    const temperature = mergedTemperature(c, opts);
    const maxTokens = storedMaxTokens(c);
    const generationConfig = {
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
    };
    return {
      url: joinUrl(c.baseUrl, `/models/${modelId(c)}:streamGenerateContent?alt=sse`),
      headers: { "x-goog-api-key": c.apiKey, "Content-Type": "application/json" },
      body: {
        system_instruction: { parts: [{ text: systemContent(messages) }] },
        contents: [{ role: "user", parts: [{ text: mergeNonSystemMessages(messages) }] }],
        ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
      },
      parseChunk: (raw) => {
        const json: unknown = JSON.parse(raw);
        if (!isObj(json) || !Array.isArray(json.candidates)) return {};
        const parts = (json.candidates[0] as { content?: { parts?: Array<{ text?: unknown }> } })
          ?.content?.parts;
        if (!Array.isArray(parts)) return {};
        const text = parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
        return text.length > 0 ? { delta: text } : {};
      },
      parseEvent: noopParseEvent,
    };
  },
};
