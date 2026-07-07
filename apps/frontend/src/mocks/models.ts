import type { ModelProtocol, ModelType } from "@codecrush/contracts";
import type { TagKey } from "./agents";

/** 模型接入页 UI 常量（非数据 mock，数据走 /api/models）：类型文案 / 协议候选（label/默认 base/说明）/ 参数定义。 */

export const TYPE_LABEL: Record<ModelType, string> = {
  llm: "LLM",
  embedding: "Embedding",
  rerank: "Rerank",
};

/** 协议候选：顺序与展示对齐原型；合法性以契约 PROTOCOLS_BY_TYPE 为准（mocks/models.test.ts 断言一致） */
export interface ProtocolOption {
  protocol: ModelProtocol;
  label: string;
  /** 选中协议时自动填入的默认 Base URL（可改，支持自部署内网地址） */
  base: string;
  /** 协议适用场景说明（抽屉协议选项下方灰字） */
  note: string;
}

export const PROTOCOL_OPTIONS: Record<ModelType, ProtocolOption[]> = {
  llm: [
    {
      protocol: "openai_compat",
      label: "OpenAI 兼容",
      base: "https://api.openai.com/v1",
      note: "DeepSeek / Qwen / vLLM 等均可用此协议，改 Base URL 即可",
    },
    {
      protocol: "anthropic",
      label: "Anthropic",
      base: "https://api.anthropic.com",
      note: "Claude 系列 · Messages API",
    },
    {
      protocol: "gemini",
      label: "Google Gemini",
      base: "https://generativelanguage.googleapis.com/v1beta",
      note: "Gemini · generateContent",
    },
  ],
  rerank: [
    {
      protocol: "self_hosted",
      label: "自部署 (HTTP)",
      base: "http://infra.internal:8080/rerank",
      note: "bge-reranker 等自建服务",
    },
    {
      protocol: "openai_compat",
      label: "OpenAI 兼容",
      base: "https://your-workspace-id.cn-beijing.maas.aliyuncs.com/compatible-api/v1",
      note: "/v1/reranks 扁平协议——阿里云百炼 qwen3-rerank（compatible-api，替换域名中的 WorkspaceId）及其他兼容网关",
    },
    {
      protocol: "cohere",
      label: "Cohere Rerank",
      base: "https://api.cohere.ai/v1",
      note: "Cohere /rerank 协议",
    },
    {
      protocol: "jina",
      label: "Jina Rerank",
      base: "https://api.jina.ai/v1",
      note: "Jina /rerank 协议",
    },
    {
      protocol: "dashscope",
      label: "阿里云 DashScope",
      base: "https://dashscope.aliyuncs.com/api/v1",
      note: "DashScope 原生 text-rerank（qwen3-rerank / qwen3-vl-rerank / gte-rerank-v2；百炼 workspace 域名 https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1 亦可）",
    },
  ],
  embedding: [
    {
      protocol: "self_hosted",
      label: "自部署 (HTTP)",
      base: "http://infra.internal:8080",
      note: "bge-m3 等自建服务",
    },
    {
      protocol: "openai_compat",
      label: "OpenAI 兼容",
      base: "https://api.openai.com/v1",
      note: "/v1/embeddings 协议",
    },
    {
      protocol: "gemini",
      label: "Google",
      base: "https://generativelanguage.googleapis.com/v1beta",
      note: "Gemini embedContent",
    },
    { protocol: "cohere", label: "Cohere", base: "https://api.cohere.ai/v1", note: "Cohere /embed 协议" },
    { protocol: "jina", label: "Jina", base: "https://api.jina.ai/v1", note: "Jina /embeddings 协议" },
  ],
};

/** 列表「协议格式」列的显示 label（按行的 type+protocol 查） */
export function protocolLabel(type: ModelType, protocol: ModelProtocol): string {
  return PROTOCOL_OPTIONS[type].find((o) => o.protocol === protocol)?.label ?? protocol;
}

export interface ModelTypeDef {
  hint: string;
  tag: TagKey;
  namePh: string;
  paramLabel: string;
  /** 按类型可编辑参数（原型：LLM temperature/max_tokens；Embedding dimensions/batch_size；Rerank top_n/threshold） */
  params: { k: string; def: string }[];
}

export const MODEL_TYPES: Record<ModelType, ModelTypeDef> = {
  llm: {
    hint: "生成 · 改写 · 意图",
    tag: "blue",
    namePh: "deepseek-chat",
    paramLabel: "默认生成参数",
    params: [
      { k: "temperature", def: "0.3" },
      { k: "max_tokens", def: "2048" },
    ],
  },
  rerank: {
    hint: "召回结果重排",
    tag: "purple",
    namePh: "bge-reranker-v2-m3",
    paramLabel: "重排参数",
    params: [
      { k: "top_n", def: "5" },
      { k: "threshold", def: "0.65" },
    ],
  },
  embedding: {
    hint: "文本向量嵌入",
    tag: "cyan",
    namePh: "bge-m3",
    paramLabel: "向量参数",
    params: [
      { k: "dimensions", def: "1024" },
      { k: "batch_size", def: "64" },
    ],
  },
};

/** 按类型取参数默认值对象（打开抽屉/切换类型时初始化） */
export function defaultParams(type: ModelType): Record<string, string> {
  return Object.fromEntries(MODEL_TYPES[type].params.map((p) => [p.k, p.def]));
}

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
  protocol: ModelProtocol;
  name: string;
  baseUrl: string;
  /** 编辑模式留空 = 不改（key 只写不回显） */
  apiKey: string;
  params: Record<string, string>;
}
