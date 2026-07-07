import type { TagKey } from "./agents";

/** M2 mock：模型调用管理页用，对齐原型 LLM_ROWS / MODEL_TYPES。M3 接真实 /api/models。 */

export type ModelType = "LLM" | "Rerank" | "Embedding";

export interface LlmRow {
  m: string;
  type: ModelType;
  role: string;
  prov: string;
  off?: boolean;
}

export const LLM_ROWS: LlmRow[] = [
  { m: "DeepSeek-V3", type: "LLM", role: "回复生成（主）", prov: "DeepSeek" },
  { m: "DeepSeek-V3 (低温)", type: "LLM", role: "问题改写 · 意图识别", prov: "DeepSeek" },
  { m: "Qwen-Max", type: "LLM", role: "生成备用 / 降级链路", prov: "阿里云" },
  { m: "GPT-4o-mini", type: "LLM", role: "评测裁判", prov: "OpenAI" },
  { m: "bge-m3", type: "Embedding", role: "向量嵌入 · 全部知识库", prov: "自部署" },
  { m: "text-embedding-3-large", type: "Embedding", role: "备用嵌入", prov: "OpenAI", off: true },
  { m: "bge-reranker-v2-m3", type: "Rerank", role: "召回重排", prov: "自部署" },
];

export interface ModelTypeDef {
  hint: string;
  tag: TagKey;
  provs: string[];
  namePh: string;
  base: string;
  paramLabel: string;
  params: { k: string; v: string }[];
}

export const MODEL_TYPES: Record<ModelType, ModelTypeDef> = {
  LLM: {
    hint: "生成 · 改写 · 意图",
    tag: "blue",
    provs: ["DeepSeek", "阿里云", "OpenAI", "智谱", "自部署"],
    namePh: "deepseek-chat",
    base: "https://api.deepseek.com/v1",
    paramLabel: "默认生成参数",
    params: [
      { k: "temperature", v: "0.3" },
      { k: "max_tokens", v: "2048" },
    ],
  },
  Rerank: {
    hint: "召回结果重排",
    tag: "purple",
    provs: ["自部署", "Jina", "Cohere", "阿里云"],
    namePh: "bge-reranker-v2-m3",
    base: "http://infra.internal:8080/rerank",
    paramLabel: "重排参数",
    params: [
      { k: "top_n", v: "5" },
      { k: "score 阈值", v: "0.65" },
    ],
  },
  Embedding: {
    hint: "文本向量嵌入",
    tag: "cyan",
    provs: ["自部署", "OpenAI", "Jina", "智谱"],
    namePh: "bge-m3",
    base: "http://infra.internal:8080/embed",
    paramLabel: "向量参数",
    params: [
      { k: "维度", v: "1024" },
      { k: "归一化", v: "是" },
    ],
  },
};

export const LLM_TABS = ["全部", "LLM", "Rerank", "Embedding"] as const;

/** 接入模型抽屉表单。 */
export interface ModelDraft {
  type: ModelType;
  prov: string;
  name: string;
  base: string;
  key: string;
}
