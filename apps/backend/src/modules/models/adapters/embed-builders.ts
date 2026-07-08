import type { ModelProtocol } from "@codecrush/contracts";
import { bearerHeaders, isObj, joinUrl, modelId } from "./protocols/types";
import type { ModelCallConfig } from "../ports/model-provider.port";

/**
 * 批量向量化请求描述：builder 是纯函数，只负责按协议构造请求体与响应解析。
 * fetch / 维度校验 / 密钥擦除统一在 ProtocolDispatchAdapter.embed()（同 PROBE_BUILDERS 的分工）。
 */
export interface EmbedRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  parseResponse: (json: unknown) => number[][];
}

export type EmbedBuilder = (config: ModelCallConfig, texts: string[]) => EmbedRequest;

function geminiHeaders(apiKey: string): Record<string, string> {
  return { "x-goog-api-key": apiKey, "Content-Type": "application/json" };
}

const dimensionsOf = (c: ModelCallConfig): number => Number(c.params?.dimensions ?? "1024");

// (protocol) → 批量向量化 builder 表：与契约 PROTOCOLS_BY_TYPE.embedding 的 5 个协议一一对应
// （完整性由 embed-builders.spec 断言，同 PROBE_BUILDERS 的查表+防御分支模式）。
// llm/rerank-only 协议（anthropic/dashscope）不在表内：ProtocolDispatchAdapter.embed() 对查不到
// builder 的情况有防御分支——契约层已收口 embedding 合法协议，此分支正常不可达。
export const EMBED_BUILDERS: Record<ModelProtocol, EmbedBuilder> = {
  self_hosted: (c, texts) => ({
    url: joinUrl(c.baseUrl, "/embed"),
    headers: bearerHeaders(c.apiKey),
    body: { inputs: texts },
    parseResponse: (json) => (Array.isArray(json) ? (json as number[][]) : []),
  }),
  openai_compat: (c, texts) => ({
    url: joinUrl(c.baseUrl, "/embeddings"),
    headers: bearerHeaders(c.apiKey),
    body: { model: modelId(c), input: texts, dimensions: dimensionsOf(c) },
    parseResponse: (json) => {
      if (!isObj(json) || !Array.isArray(json.data)) return [];
      return (json.data as Array<{ embedding: number[] }>).map((d) => d.embedding);
    },
  }),
  gemini: (c, texts) => ({
    url: joinUrl(c.baseUrl, `/models/${modelId(c)}:batchEmbedContents`),
    headers: geminiHeaders(c.apiKey),
    body: {
      requests: texts.map((t) => ({
        model: `models/${modelId(c)}`,
        content: { parts: [{ text: t }] },
      })),
    },
    parseResponse: (json) => {
      if (!isObj(json) || !Array.isArray(json.embeddings)) return [];
      return (json.embeddings as Array<{ values: number[] }>).map((e) => e.values);
    },
  }),
  cohere: (c, texts) => ({
    url: joinUrl(c.baseUrl, "/embed"),
    headers: bearerHeaders(c.apiKey),
    body: { model: modelId(c), texts, input_type: "search_document" },
    parseResponse: (json) => {
      if (!isObj(json)) return [];
      return Array.isArray(json.embeddings) ? (json.embeddings as number[][]) : [];
    },
  }),
  jina: (c, texts) => ({
    url: joinUrl(c.baseUrl, "/embeddings"),
    headers: bearerHeaders(c.apiKey),
    body: { model: modelId(c), input: texts },
    parseResponse: (json) => {
      if (!isObj(json) || !Array.isArray(json.data)) return [];
      return (json.data as Array<{ embedding: number[] }>).map((d) => d.embedding);
    },
  }),
} as Record<string, EmbedBuilder>;
