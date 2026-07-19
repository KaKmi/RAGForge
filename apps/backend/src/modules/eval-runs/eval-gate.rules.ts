import { EVAL_GATE_ISSUE_CODES, type ReleaseCheckIssue } from "@codecrush/contracts";

/** 原型 §8：「候选版本存在 24h 内、对当前 production 的对比 run」。 */
export const GATE_FRESHNESS_MS = 24 * 60 * 60 * 1000;

export type GateInput =
  | { kind: "compared"; finishedAt: Date; regressedCount: number; overallDelta: number | null }
  | { kind: "no_run" }
  | { kind: "unavailable" };

const warn = (code: string, message: string): ReleaseCheckIssue => ({
  code,
  message,
  severity: "warning",
});

/**
 * 跌幅文案的数值格式。
 *
 * **不能用 `Math.round`**：`overallScore` 本身就是 `ROUND(...,1)` 的一位小数
 * （eval-runs.repository.ts:104），故 `-0.3` 这类取值真实可达；round 后成 `0`，
 * 会弹出「综合分下降 0 分」——一条自我否定的警告。
 *
 * 先 `abs` 再 `toFixed(1)` 吸收浮点残差（`79.9 - 80.2 === -0.30000000000000426`），
 * 再用 `Number()` 去掉整数的尾随 `.0`，使整数跌幅仍是「下降 4 分」而非「下降 4.0 分」。
 */
function formatDelta(delta: number): string {
  return String(Number(Math.abs(delta).toFixed(1)));
}

/**
 * 门禁结论 → issue[]。**永远只产 warning**（先软提示，原型 §16 Q1）。
 *
 * fail-open：`no_run` / `stale` / `unavailable` 都放行，只是把「为什么说不清楚」讲明白。
 * 理由见 spec §0 必答题 1——质量判断在证据缺失时的默认是「说不清楚」，不是「判定有罪」；
 * 真正的安全断言由 publishProduction 的门禁四连（归属/passed/未过期/fingerprint）承担。
 */
export function buildGateIssues(input: GateInput, now: Date): ReleaseCheckIssue[] {
  if (input.kind === "no_run") {
    return [warn(EVAL_GATE_ISSUE_CODES.NO_RUN, "该版本尚未与当前 production 做过对比评测")];
  }
  if (input.kind === "unavailable") {
    // 文案必须含「未做回退判断」：读取失败若显示成中性提示，会被读成「查过了，没问题」。
    return [warn(EVAL_GATE_ISSUE_CODES.UNAVAILABLE, "评测数据暂不可用，未做回退判断")];
  }
  const issues: ReleaseCheckIssue[] = [];
  if (now.getTime() - input.finishedAt.getTime() > GATE_FRESHNESS_MS) {
    issues.push(
      warn(EVAL_GATE_ISSUE_CODES.STALE_RUN, "最近一次对比评测已超过 24 小时，结论可能过时"),
    );
  }
  if (input.regressedCount > 0) {
    // 原型 §17.4 逐字：「存在 5 条回退用例」
    issues.push(warn(EVAL_GATE_ISSUE_CODES.REGRESSION, `存在 ${input.regressedCount} 条回退用例`));
  }
  // NULL 不退化为 0：overallDelta 为 null 表示某侧无已评用例，
  // 此时声称「下降」需要一个并不存在的数值证据。
  if (input.overallDelta !== null && input.overallDelta < 0) {
    issues.push(
      warn(EVAL_GATE_ISSUE_CODES.OVERALL_DROP, `综合分下降 ${formatDelta(input.overallDelta)} 分`),
    );
  }
  return issues;
}
