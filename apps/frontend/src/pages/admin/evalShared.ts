import type { EvalRunStatus } from "@codecrush/contracts";

/**
 * 评测相关页面（屏2 题库 / 屏3 报告 / 屏4 对比）跨页共享的常量与格式化。
 *
 * 抽出来的都是「两个页面必须口径一致、否则会静默不一致」的东西：
 * 同一个指标在报告页和对比页显示成不同精度、或两页对「可对比 run」的判定不同，
 * 都是没有测试会红、但用户会看到的 bug。
 */

/** F8：只有有结果的终态 run 可参与对比（同屏3 报告的 run population）。 */
export const COMPARABLE_RUN_STATUSES: readonly EvalRunStatus[] = [
  "done",
  "partial",
  "budget_stop",
];

/** §17.4：|Δ|≥3 才算显著（与后端 eval-compare.ts 的 SIGNIFICANT_DELTA 同值）。 */
export const SIGNIFICANT_DELTA = 3;

/** §19.1：gold 文档最多 10 个引用。 */
export const GOLD_DOC_MAX = 10;

/** 检索层 gold 指标的两位小数格式化（原型 §7：`NDCG@5 0.81`）。 */
export function formatNdcg5(value: number): string {
  return (value / 100).toFixed(2);
}

/** 检索层 gold 指标的百分比格式化（原型 §7：`命中率@5 92%`）。 */
export function formatHitRate5(value: number): string {
  return `${value}%`;
}
