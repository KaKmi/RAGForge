import { z } from "zod";

// 014 D1：两级意图表（大分类 + 小分类判断锚点），第一版代码写死（011 §7 同款「先写死、后 DB+UI」边界）。
// key = 稳定标识（存 KB 绑定列、编排路由、trace）；label/criteria = 文案。
// criteria（小分类）仅作 LLM 判断锚点（先匹小分类再归拢大分类），不做检索过滤（延后 M4/M5）。
export interface IntentCategory {
  key: string;
  label: string;
  criteria: string[];
}

export const INTENT_TABLE: IntentCategory[] = [
  {
    key: "SUPPORT",
    label: "产品咨询",
    criteria: [
      "产品定位",
      "产品原则",
      "产品理念",
      "使用场景",
      "产品价格",
      "竞品比较",
      "使用方法/操作步骤",
      "下载安装/注册登录/账号",
    ],
  },
  {
    key: "FEEDBACK",
    label: "问题反馈",
    criteria: ["功能异常/报错/打不开/卡顿", "功能优化建议/希望增加功能"],
  },
];

/** 闲聊：恒存在的保留 key，不可绑 KB，编排层不检索、直走兜底。 */
export const CHAT_INTENT_KEY = "CHAT";
/** 分类失败/无法归类：编排层回退全 KB 召回。 */
export const UNKNOWN_INTENT_KEY = "UNKNOWN";

/** 意图节点输出闭集 = 全表 ∪ CHAT ∪ UNKNOWN（outputSchema enum 硬约束，014 不变量 1）。 */
export const INTENT_OUTPUT_KEYS = [
  ...INTENT_TABLE.map((c) => c.key),
  CHAT_INTENT_KEY,
  UNKNOWN_INTENT_KEY,
] as const;

/** KB 可绑值域 = 仅业务 key（排除 CHAT/UNKNOWN）。 */
export const IntentKeySchema = z.enum(INTENT_TABLE.map((c) => c.key) as [string, ...string[]]);
export type IntentKey = z.infer<typeof IntentKeySchema>;
