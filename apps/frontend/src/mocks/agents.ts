/** Agent 管理页展示常量（真实数据经 api/client.ts 获取，见 AgentsPage.tsx）。
 * TAGS/tagOf 为跨页共用色板（Models/Traces/Evals 等页也引用）。 */

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

/** Agent 派生 status → 列表标签（M7，008 数据模型的三态派生） */
export const STATUS_TAG: Record<"draft" | "active" | "archived", { label: string; tag: TagKey }> = {
  draft: { label: "草稿", tag: "purple" },
  active: { label: "已上线", tag: "green" },
  archived: { label: "已下线", tag: "gray" },
};

/** 配置版本 Eval 状态展示文案（M7 stub 阶段，M11 换真实评测后调整） */
export const EVAL_STATUS_LABEL: Record<"not_run" | "passed" | "exempt", string> = {
  not_run: "未跑 Eval",
  passed: "Eval 通过（占位）",
  exempt: "豁免（首个版本）",
};
