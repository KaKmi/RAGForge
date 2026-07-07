import type { PromptNode, PromptVersionStatus } from "@codecrush/contracts";
import type { TagKey } from "./agents";

/**
 * M6：Prompt 管理页 UI 常量（颜色 / hint / 示例值 / 状态色板）。
 * 类型对齐 contracts 英文 enum（rewrite/intent/reply/fallback、draft/prod/archived），
 * 用 NODE_LABEL / STATUS_LABEL 在 UI 显中文。mock 数据与本地纯函数已迁出——
 * 数据走 `@codecrush/contracts` 的 Prompt/PromptVersion + `api/client`；
 * 纯逻辑（extractVars/renderTemplate/diffPromptBodies）走 contracts/prompt-template。
 */

export type { PromptNode, PromptVersionStatus };

/** 节点 → UI 颜色 tag。 */
export const NODE_TAGS: Record<PromptNode, TagKey> = {
  rewrite: "blue",
  intent: "purple",
  reply: "green",
  fallback: "gold",
};

/** 节点 → 中文标签。 */
export const NODE_LABEL: Record<PromptNode, string> = {
  rewrite: "问题改写",
  intent: "意图识别",
  reply: "回复生成",
  fallback: "兜底",
};

export const NODE_META: Record<PromptNode, { hint: string; vars: string[] }> = {
  rewrite: {
    hint: "结合历史对话把用户问题改写为独立、可检索的查询，输出改写结果与扩展关键词。",
    vars: ["{query}", "{history}"],
  },
  intent: {
    hint: "判断用户问题意图并路由到对应知识库，通常要求输出结构化 JSON。",
    vars: ["{query}"],
  },
  reply: {
    hint: "基于命中知识生成最终回复，需约束“不得编造”并为每条引用标注角标。",
    vars: ["{context}", "{query}", "{policy_date}", "{user_level}"],
  },
  fallback: {
    hint: "当问题超出知识库范围或相似度过低时的礼貌兜底话术。",
    vars: ["{query}"],
  },
};

/** 变量 → 示例值（预览填充用）。 */
export const VAR_PH: Record<string, string> = {
  "{query}": "如：7 天内没学能全额退吗",
  "{question}": "如：7 天内没学能全额退吗",
  "{history}": "如：用户此前咨询过退款政策",
  "{context}": "如：第二条 七天无理由退款…",
  "{policy_date}": "2026-06-18",
  "{user_level}": "零基础",
  "{intent}": "售后",
};

/** 版本状态 → 色板（对齐 contracts draft/prod/archived）。 */
export const STV: Record<PromptVersionStatus, { bg: string; c: string; bd: string }> = {
  draft: { bg: "#f9f0ff", c: "#722ed1", bd: "#d3adf7" },
  prod: { bg: "#f6ffed", c: "#52c41a", bd: "#b7eb8f" },
  archived: { bg: "#fafafa", c: "rgba(0,0,0,.45)", bd: "#e8e8e8" },
};

/** 状态 → 中文标签。 */
export const STATUS_LABEL: Record<PromptVersionStatus, string> = {
  draft: "草稿",
  prod: "生产中",
  archived: "已归档",
};

/**
 * 编译期护栏：`Record<PromptNode, TagKey>` / `Record<PromptVersionStatus, ...>`
 * 强制 UI 常量 key 覆盖契约 enum 全部成员；契约加新枚举时此处编译失败，提醒同步 UI。
 */
