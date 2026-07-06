import { Tag } from "antd";

/** 状态枚举 → antd Tag color 映射（对齐原型 TAGS 配色） */
const COLOR_MAP: Record<string, string> = {
  // agent
  active: "green",
  draft: "gold",
  archived: "default",
  // knowledge-base / document
  ready: "green",
  building: "gold",
  failed: "red",
  upload: "default",
  ingest: "gold",
  // trace
  ok: "green",
  error: "red",
  // prompt version
  prod: "green",
};

/** 状态枚举 → 中文展示文案（契约用英文枚举，前端展示中文） */
const LABEL_MAP: Record<string, string> = {
  active: "运行中",
  draft: "草稿",
  archived: "已归档",
  ready: "已就绪",
  building: "构建中",
  failed: "失败",
  upload: "已上传",
  ingest: "解析中",
  ok: "成功",
  error: "错误",
  prod: "已发布",
};

interface StatusTagProps {
  status: string;
  label?: string;
}

export function StatusTag({ status, label }: StatusTagProps) {
  return <Tag color={COLOR_MAP[status] ?? "default"}>{label ?? LABEL_MAP[status] ?? status}</Tag>;
}
