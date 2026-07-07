/** M2 mock：Agent 管理页用，对齐原型 AGENT_ROWS / DF_DEFAULT。M7 接真实 /api/agents。 */

/** 状态/类型色板（与原型 TAGS 一致，知识库/模型页共用）。 */
export type TagKey = "green" | "blue" | "gold" | "red" | "gray" | "purple" | "cyan";

export const TAGS: Record<TagKey, { bg: string; c: string; bd: string }> = {
  green: { bg: "#f6ffed", c: "#52c41a", bd: "#b7eb8f" },
  blue: { bg: "#e6f4ff", c: "#1677ff", bd: "#91caff" },
  gold: { bg: "#fffbe6", c: "#d48806", bd: "#ffe58f" },
  red: { bg: "#fff2f0", c: "#ff4d4f", bd: "#ffccc7" },
  gray: { bg: "#fafafa", c: "rgba(0,0,0,.45)", bd: "#d9d9d9" },
  purple: { bg: "#f9f0ff", c: "#722ed1", bd: "#d3adf7" },
  cyan: { bg: "#e6fffb", c: "#08979c", bd: "#87e8de" },
};

export function tagOf(name: TagKey) {
  return TAGS[name] || TAGS.gray;
}

export interface AgentRow {
  name: string;
  desc: string;
  initial: string;
  color: string;
  kbs: string[];
  model: string;
  st: string;
  tag: TagKey;
  updated: string;
}

export const AGENT_ROWS: AgentRow[] = [
  { name: "售后支持", desc: "退款 · 换课 · 发票", initial: "售", color: "#1677ff", kbs: ["售后服务知识库", "订单FAQ"], model: "DeepSeek-V3", st: "已上线", tag: "green", updated: "2026-06-28" },
  { name: "课程顾问", desc: "选课 · 价格 · 优惠", initial: "课", color: "#722ed1", kbs: ["课程目录库", "价格政策"], model: "DeepSeek-V3", st: "已上线", tag: "green", updated: "2026-06-30" },
  { name: "学习助手", desc: "路径 · 作业 · 证书", initial: "学", color: "#13c2c2", kbs: ["学习指南库"], model: "Qwen-Max", st: "已上线", tag: "green", updated: "2026-06-21" },
  { name: "活动营销助手", desc: "大促活动答疑", initial: "活", color: "#bfbfbf", kbs: ["活动物料库"], model: "DeepSeek-V3", st: "已下线", tag: "gray", updated: "2026-05-11" },
];

/** Agent 抽屉可选知识库（原型 ALL_KBS）。 */
export const ALL_KBS = ["课程目录库", "售后服务知识库", "学习指南库", "订单FAQ", "价格政策", "活动物料库"];

/** Agent 抽屉下拉选项（对齐原型 <option>）。 */
export const GEN_MODELS = ["DeepSeek-V3", "Qwen-Max", "GPT-4o"];
export const LIGHT_MODELS = ["DeepSeek-V3 (低温)", "Qwen-Max", "GPT-4o-mini"];
export const RERANK_MODELS = ["bge-reranker-v2-m3", "Jina Reranker v2", "不启用重排"];
export const PROMPT_REWRITE_OPTS = ["问题改写-通用 v7", "问题改写-多轮 v3"];
export const PROMPT_INTENT_OPTS = ["意图识别-三分类 v4", "意图识别-细粒度 v2"];
export const PROMPT_REPLY_OPTS = ["售后回复生成 v12", "课程推荐生成 v9"];
export const PROMPT_FALLBACK_OPTS = ["兜底话术 v3", "兜底话术-引导留资 v1"];

/** 新建 Agent 抽屉表单初值（原型 DF_DEFAULT）。 */
export interface AgentDraft {
  name: string;
  desc: string;
  kbs: string[];
  fallback: boolean;
  genModel: string;
  lightModel: string;
  rerankModel: string;
  promptRewrite: string;
  promptIntent: string;
  promptReply: string;
  promptFallback: string;
  topK: string;
  topN: string;
  threshold: string;
  multi: boolean;
}

export const DF_DEFAULT: AgentDraft = {
  name: "",
  desc: "",
  kbs: [],
  fallback: true,
  genModel: "DeepSeek-V3",
  lightModel: "DeepSeek-V3 (低温)",
  rerankModel: "bge-reranker-v2-m3",
  promptRewrite: "问题改写-通用 v7",
  promptIntent: "意图识别-三分类 v4",
  promptReply: "售后回复生成 v12",
  promptFallback: "兜底话术 v3",
  topK: "20",
  topN: "5",
  threshold: "0.65",
  multi: true,
};
