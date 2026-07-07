/** M2 mock：运行看板页用。形状对齐原型 STATS / AGENT_DIST / HOT_QS / 折线图点位。M10 接真实看板数据。 */

export interface DashboardStat {
  label: string;
  value: string;
  delta: string;
  /** delta 颜色（正/负向） */
  dc: string;
  sub: string;
}

export const MOCK_STATS: DashboardStat[] = [
  { label: "今日问答量", value: "1,284", delta: "+12.4%", dc: "#52c41a", sub: "较昨日" },
  { label: "平均响应耗时", value: "2.1s", delta: "-0.3s", dc: "#52c41a", sub: "P95 4.8s" },
  { label: "召回命中率", value: "91.2%", delta: "+1.8%", dc: "#52c41a", sub: "近 7 日均值 89.6%" },
  { label: "兜底率", value: "3.8%", delta: "+0.6%", dc: "#ff4d4f", sub: "未命中知识 / 转人工" },
];

export interface AgentDist {
  name: string;
  pct: number;
  n: string;
  color: string;
}

export const MOCK_AGENT_DIST: AgentDist[] = [
  { name: "售后支持", pct: 46, n: "591", color: "#1677ff" },
  { name: "课程顾问", pct: 32, n: "411", color: "#722ed1" },
  { name: "学习助手", pct: 18, n: "231", color: "#13c2c2" },
  { name: "兜底 / 未路由", pct: 4, n: "51", color: "#faad14" },
];

export interface HotQuestion {
  q: string;
  n: number;
}

export const MOCK_HOT_QS: HotQuestion[] = [
  { q: "课程可以退款吗", n: 214 },
  { q: "课程有效期多久", n: 167 },
  { q: "结课证书怎么申请", n: 132 },
  { q: "优惠券怎么使用", n: 98 },
  { q: "如何更换绑定手机号", n: 76 },
];

// 近 7 日问答量折线图（SVG viewBox 0 0 560 170）
export const MOCK_TREND_POINTS = "20,140 106,111 193,94 280,126 366,67 453,49 540,26";
export const MOCK_TREND_AREA =
  "20,140 106,111 193,94 280,126 366,67 453,49 540,26 540,160 20,160";
export const MOCK_TREND_LABELS = ["06-26", "06-29", "07-02"];
export const MOCK_TREND_LAST = "1,284";
