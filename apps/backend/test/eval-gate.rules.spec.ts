import { EVAL_GATE_ISSUE_CODES } from "@codecrush/contracts";
import { buildGateIssues, GATE_FRESHNESS_MS } from "../src/modules/eval-runs/eval-gate.rules";

const NOW = new Date("2026-07-18T12:00:00Z");
const FRESH = new Date(NOW.getTime() - 60 * 60 * 1000); // 1h 前
const STALE = new Date(NOW.getTime() - GATE_FRESHNESS_MS - 1000);

describe("buildGateIssues", () => {
  it("有回退用例 → warning 级 REGRESSION，文案逐字「存在 N 条回退用例」", () => {
    const issues = buildGateIssues(
      { kind: "compared", finishedAt: FRESH, regressedCount: 5, overallDelta: 3.6 },
      NOW,
    );
    expect(issues).toEqual([
      { code: EVAL_GATE_ISSUE_CODES.REGRESSION, message: "存在 5 条回退用例", severity: "warning" },
    ]);
  });

  it("综合分下降 → OVERALL_DROP", () => {
    const issues = buildGateIssues(
      { kind: "compared", finishedAt: FRESH, regressedCount: 0, overallDelta: -4 },
      NOW,
    );
    expect(issues).toEqual([
      { code: EVAL_GATE_ISSUE_CODES.OVERALL_DROP, message: "综合分下降 4 分", severity: "warning" },
    ]);
  });

  /**
   * 【勿删】overallScore 是 ROUND(...,1) 的一位小数，故 -0.3 真实可达。
   * 若用 Math.round 格式化，会弹出「综合分下降 0 分」——一条自我否定的警告。
   */
  it("小数跌幅不得被舍成 0：-0.3 → 「综合分下降 0.3 分」", () => {
    const issues = buildGateIssues(
      { kind: "compared", finishedAt: FRESH, regressedCount: 0, overallDelta: 79.9 - 80.2 },
      NOW,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe("综合分下降 0.3 分");
    // 反向断言：绝不能出现「下降 0 分」这种自相矛盾的文案
    expect(issues[0].message).not.toContain("下降 0 分");
  });

  /**
   * 【跨文件耦合的钉，勿删】
   * |delta| < 0.05 仍会渲染成「下降 0 分」。这在今天**不可达**，唯一的理由是
   * overallScore 是 `ROUND(AVG(...)::numeric, 1)`（eval-runs.repository.ts:101-113），
   * 故任何非零 delta 都是 0.1 的倍数。若哪天把那个 ROUND 去掉，这条会红——
   * 那正是我们要的提醒，而不是让「下降 0 分」重新溜回 UI。
   */
  it("形式化记录：|delta|<0.05 会退化成 0（依赖 SQL 侧 ROUND(...,1) 才不可达）", () => {
    const issues = buildGateIssues(
      { kind: "compared", finishedAt: FRESH, regressedCount: 0, overallDelta: -0.04 },
      NOW,
    );
    expect(issues[0].message).toBe("综合分下降 0 分");
  });

  it("整数跌幅不带尾随 .0（保持原型口径「下降 4 分」）", () => {
    const issues = buildGateIssues(
      { kind: "compared", finishedAt: FRESH, regressedCount: 0, overallDelta: -4 },
      NOW,
    );
    expect(issues[0].message).toBe("综合分下降 4 分");
  });

  it("无回退且综合不降 → 零 issue", () => {
    expect(
      buildGateIssues(
        { kind: "compared", finishedAt: FRESH, regressedCount: 0, overallDelta: 3.6 },
        NOW,
      ),
    ).toEqual([]);
  });

  it("没有对比 run → fail-open：NO_RUN，warning", () => {
    const issues = buildGateIssues({ kind: "no_run" }, NOW);
    expect(issues).toEqual([
      {
        code: EVAL_GATE_ISSUE_CODES.NO_RUN,
        message: "该版本尚未与当前 production 做过对比评测",
        severity: "warning",
      },
    ]);
  });

  it("对比 run 超 24h → STALE_RUN 且仍报回退（两条并存）", () => {
    const issues = buildGateIssues(
      { kind: "compared", finishedAt: STALE, regressedCount: 2, overallDelta: 1 },
      NOW,
    );
    expect(issues).toEqual([
      {
        code: EVAL_GATE_ISSUE_CODES.STALE_RUN,
        message: "最近一次对比评测已超过 24 小时，结论可能过时",
        severity: "warning",
      },
      { code: EVAL_GATE_ISSUE_CODES.REGRESSION, message: "存在 2 条回退用例", severity: "warning" },
    ]);
  });

  it("读取失败 → fail-open：UNAVAILABLE，warning，文案必须含「未做回退判断」", () => {
    const issues = buildGateIssues({ kind: "unavailable" }, NOW);
    expect(issues).toEqual([
      {
        code: EVAL_GATE_ISSUE_CODES.UNAVAILABLE,
        message: "评测数据暂不可用，未做回退判断",
        severity: "warning",
      },
    ]);
  });

  /**
   * overallDelta 为 null ⟺ 任一侧 overallScore 为 null（eval-compare.ts:135-138），
   * 即某侧无任何已评用例。此时不得声称「下降」——那需要一个并不存在的数值证据
   * （同仓既有原则：avgPerCase 除零只能给 null 不能给 0，eval-compare.ts:139-143）。
   * regressedCount 仍照常判定（逐用例分类不依赖总分）。
   */
  it("overallDelta 为 null：不产 OVERALL_DROP，但仍判回退", () => {
    expect(
      buildGateIssues(
        { kind: "compared", finishedAt: FRESH, regressedCount: 0, overallDelta: null },
        NOW,
      ),
    ).toEqual([]);
    expect(
      buildGateIssues(
        { kind: "compared", finishedAt: FRESH, regressedCount: 3, overallDelta: null },
        NOW,
      ),
    ).toEqual([
      { code: EVAL_GATE_ISSUE_CODES.REGRESSION, message: "存在 3 条回退用例", severity: "warning" },
    ]);
  });

  it("门禁 issue 永远不含 error 级 —— 软提示不变量", () => {
    const all = [
      buildGateIssues(
        { kind: "compared", finishedAt: STALE, regressedCount: 9, overallDelta: -9 },
        NOW,
      ),
      buildGateIssues({ kind: "no_run" }, NOW),
      buildGateIssues({ kind: "unavailable" }, NOW),
    ].flat();
    expect(all.every((i) => i.severity === "warning")).toBe(true);
    expect(all.length).toBeGreaterThan(0);
  });
});
