import type { EvalRun, EvalSet } from "@codecrush/contracts";

/** M2 mock：评测集 / 评测运行页用。M11 接真实评测管线。 */

export const MOCK_EVAL_SETS: EvalSet[] = [
  { id: "es1", name: "售后基础问答集", desc: "退换货/保修/物流高频问题", caseCount: 48 },
  { id: "es2", name: "产品咨询集", desc: "规格/功能/对比", caseCount: 32 },
];

export const MOCK_EVAL_RUNS: EvalRun[] = [
  {
    id: "er1",
    setId: "es1",
    agentId: "aftersale",
    total: 48,
    time: "2026-07-05T16:00:00Z",
    metrics: [
      { label: "召回率", value: "0.92", pct: "92%", color: "green" },
      { label: "准确率", value: "0.85", pct: "85%", color: "blue" },
      { label: "引用命中", value: "0.88", pct: "88%", color: "green" },
    ],
    cases: [
      { q: "退货流程怎么走？", recall: "命中", acc: "正确", cite: "[1][2]", st: "通过", tag: "退换货" },
      { q: "保修期多久？", recall: "命中", acc: "正确", cite: "[1]", st: "通过", tag: "保修" },
      { q: "物流几天到？", recall: "未命中", acc: "错误", cite: "—", st: "失败", tag: "物流" },
    ],
  },
  {
    id: "er2",
    setId: "es1",
    agentId: "presale",
    total: 48,
    time: "2026-07-04T11:00:00Z",
    metrics: [
      { label: "召回率", value: "0.78", pct: "78%", color: "gold" },
      { label: "准确率", value: "0.70", pct: "70%", color: "gold" },
      { label: "引用命中", value: "0.72", pct: "72%", color: "gold" },
    ],
    cases: [],
  },
];
