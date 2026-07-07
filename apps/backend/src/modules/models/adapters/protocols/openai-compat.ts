import { bearerHeaders, isObj, joinUrl, modelId, type ProbeBuilder } from "./types";

// OpenAI 兼容：DeepSeek / Qwen / vLLM 等均可用此协议，改 Base URL 即可

export const openaiCompatChatProbe: ProbeBuilder = (c) => ({
  url: joinUrl(c.baseUrl, "/chat/completions"),
  headers: bearerHeaders(c.apiKey),
  body: {
    model: modelId(c),
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
  },
  shapeOk: (json) => isObj(json) && Array.isArray(json.choices),
});

// OpenAI 兼容 rerank（OpenAI 官方无 rerank API，此为生态兼容形态）：
// 阿里云百炼 compatible-api（https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-api/v1/reranks，
// qwen3-rerank 推荐接法）等网关；扁平 body {model, query, documents, top_n}
export const openaiCompatRerankProbe: ProbeBuilder = (c) => ({
  url: joinUrl(c.baseUrl, "/reranks"),
  headers: bearerHeaders(c.apiKey),
  body: { model: modelId(c), query: "ping", documents: ["ping", "pong"], top_n: 1 },
  shapeOk: (json) => isObj(json) && (Array.isArray(json.results) || Array.isArray(json.data)),
});

export const openaiCompatEmbeddingProbe: ProbeBuilder = (c) => ({
  url: joinUrl(c.baseUrl, "/embeddings"),
  headers: bearerHeaders(c.apiKey),
  body: { model: modelId(c), input: "ping" },
  shapeOk: (json) => {
    if (!isObj(json) || !Array.isArray(json.data)) return false;
    const first = json.data[0] as Record<string, unknown> | undefined;
    return Array.isArray(first?.embedding);
  },
});
