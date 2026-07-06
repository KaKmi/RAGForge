import type { ModelProvider } from "@codecrush/contracts";

/** M2 mock：模型调用管理页用。M3 接真实 /api/models。 */
export const MOCK_MODELS: ModelProvider[] = [
  {
    id: "m1",
    type: "llm",
    provider: "openai",
    name: "gpt-4o",
    baseUrl: "https://api.openai.com/v1",
    apiKeyMasked: "sk-***abc1",
    role: "生成",
    enabled: true,
  },
  {
    id: "m2",
    type: "llm",
    provider: "deepseek",
    name: "deepseek-chat",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyMasked: "sk-***def2",
    role: "轻量",
    enabled: true,
  },
  {
    id: "m3",
    type: "embedding",
    provider: "bge",
    name: "bge-m3",
    baseUrl: "http://localhost:11434",
    role: "向量",
    enabled: true,
  },
  {
    id: "m4",
    type: "rerank",
    provider: "bge",
    name: "bge-reranker-v2-m3",
    baseUrl: "http://localhost:11434",
    role: "重排",
    enabled: false,
  },
];
