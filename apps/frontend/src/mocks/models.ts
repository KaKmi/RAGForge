import type { ModelType } from "@codecrush/contracts";
import type { TagKey } from "./agents";

/** 模型接入页 UI 常量（非数据 mock，数据走 /api/models）：类型文案 / provider 候选 / baseUrl placeholder / 参数提示。 */

export const TYPE_LABEL: Record<ModelType, string> = {
  llm: "LLM",
  embedding: "Embedding",
  rerank: "Rerank",
};

export interface ModelTypeDef {
  hint: string;
  tag: TagKey;
  provs: string[];
  namePh: string;
  /** 根形态 URL；后端 adapter 自动拼 canonical 路径（/chat/completions | /embeddings | /rerank） */
  base: string;
  paramLabel: string;
  params: { k: string; v: string }[];
}

export const MODEL_TYPES: Record<ModelType, ModelTypeDef> = {
  llm: {
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
  rerank: {
    hint: "召回结果重排",
    tag: "purple",
    provs: ["自部署", "Jina", "Cohere", "阿里云"],
    namePh: "bge-reranker-v2-m3",
    base: "http://infra.internal:8080",
    paramLabel: "重排参数",
    params: [
      { k: "top_n", v: "5" },
      { k: "score 阈值", v: "0.65" },
    ],
  },
  embedding: {
    hint: "文本向量嵌入",
    tag: "cyan",
    provs: ["自部署", "OpenAI", "Jina", "智谱"],
    namePh: "bge-m3",
    base: "http://infra.internal:8080",
    paramLabel: "向量参数",
    params: [
      { k: "维度", v: "1024" },
      { k: "归一化", v: "是" },
    ],
  },
};

export const MODEL_TABS: Array<{ key: "all" | ModelType; label: string }> = [
  { key: "all", label: "全部" },
  { key: "llm", label: "LLM" },
  { key: "rerank", label: "Rerank" },
  { key: "embedding", label: "Embedding" },
];

/** 接入/编辑模型抽屉表单。 */
export interface ModelDraft {
  /** 有值 = 编辑模式 */
  id?: string;
  type: ModelType;
  provider: string;
  name: string;
  baseUrl: string;
  /** 编辑模式留空 = 不改 */
  apiKey: string;
}
