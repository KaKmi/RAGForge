/** M2 mock：运行看板页用。M10 接真实看板数据。 */

export interface DashboardStats {
  todayQuestions: number;
  avgDurationMs: number;
  fallbackRate: number;
  hotQuestions: { q: string; count: number }[];
}

export const MOCK_DASHBOARD: DashboardStats = {
  todayQuestions: 1284,
  avgDurationMs: 1320,
  fallbackRate: 0.08,
  hotQuestions: [
    { q: "退货流程怎么走？", count: 86 },
    { q: "保修期多久？", count: 54 },
    { q: "物流几天到？", count: 42 },
    { q: "怎么开发票？", count: 31 },
  ],
};

export interface AgentDistribution {
  name: string;
  count: number;
}

export const MOCK_AGENT_DIST: AgentDistribution[] = [
  { name: "售后客服 Agent", count: 860 },
  { name: "售前咨询 Agent", count: 424 },
];
