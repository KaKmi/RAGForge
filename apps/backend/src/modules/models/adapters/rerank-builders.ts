import type { ModelProtocol } from "@codecrush/contracts";
import { bearerHeaders, isObj, joinUrl, modelId } from "./protocols/types";
import type { ModelCallConfig } from "../ports/model-provider.port";

/**
 * 批量重排请求描述：builder 是纯函数，只负责按协议构造请求体与响应解析。
 * fetch / 超时 / 密钥擦除统一在 ProtocolDispatchAdapter.rerank()（同 EMBED_BUILDERS 的分工）。
 */
export interface RerankRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  parseResponse: (json: unknown) => { index: number; score: number }[];
}

export type RerankBuilder = (
  config: ModelCallConfig,
  query: string,
  documents: string[],
  topN?: number,
) => RerankRequest;

// {results:[{index, relevance_score}]} 是 cohere/jina/openai_compat(results 分支)共用形态
function parseResultsField(json: unknown): { index: number; score: number }[] {
  if (!isObj(json) || !Array.isArray(json.results)) return [];
  return (json.results as Array<Record<string, unknown>>).map((r) => ({
    index: Number(r.index),
    score: Number(r.relevance_score ?? r.score),
  }));
}

// (protocol) → 批量重排 builder 表：与契约 PROTOCOLS_BY_TYPE.rerank 的 5 个协议一一对应
// （完整性由 rerank-builders.spec 断言，同 EMBED_BUILDERS 的查表+防御分支模式）。
// llm/embedding-only 协议（anthropic/gemini）不在表内：ProtocolDispatchAdapter.rerank() 对查不到
// builder 的情况有防御分支——契约层已收口 rerank 合法协议，此分支正常不可达。
export const RERANK_BUILDERS: Record<ModelProtocol, RerankBuilder> = {
  self_hosted: (c, query, documents) => ({
    url: joinUrl(c.baseUrl, "/rerank"),
    headers: bearerHeaders(c.apiKey),
    body: { query, texts: documents },
    parseResponse: (json) =>
      Array.isArray(json)
        ? (json as Array<{ index: number; score: number }>).map((r) => ({
            index: r.index,
            score: r.score,
          }))
        : [],
  }),
  openai_compat: (c, query, documents, topN) => ({
    url: joinUrl(c.baseUrl, "/reranks"),
    headers: bearerHeaders(c.apiKey),
    body: { model: modelId(c), query, documents, top_n: topN ?? documents.length },
    // 阿里云百炼等兼容网关可能用 results 或 data 包裹，两个字段名都要能解析
    parseResponse: (json) => {
      const viaResults = parseResultsField(json);
      if (viaResults.length) return viaResults;
      if (isObj(json) && Array.isArray(json.data)) {
        return (json.data as Array<Record<string, unknown>>).map((r) => ({
          index: Number(r.index),
          score: Number(r.relevance_score ?? r.score),
        }));
      }
      return [];
    },
  }),
  cohere: (c, query, documents, topN) => ({
    url: joinUrl(c.baseUrl, "/rerank"),
    headers: bearerHeaders(c.apiKey),
    body: { model: modelId(c), query, documents, top_n: topN ?? documents.length },
    parseResponse: parseResultsField,
  }),
  jina: (c, query, documents, topN) => ({
    url: joinUrl(c.baseUrl, "/rerank"),
    headers: bearerHeaders(c.apiKey),
    body: { model: modelId(c), query, documents, top_n: topN ?? documents.length },
    parseResponse: parseResultsField,
  }),
  dashscope: (c, query, documents, topN) => ({
    url: joinUrl(c.baseUrl, "/services/rerank/text-rerank/text-rerank"),
    headers: bearerHeaders(c.apiKey),
    body: {
      model: modelId(c),
      input: { query, documents },
      parameters: { top_n: topN ?? documents.length },
    },
    parseResponse: (json) => {
      if (!isObj(json) || !isObj(json.output)) return [];
      return parseResultsField(json.output);
    },
  }),
} as Record<string, RerankBuilder>;
