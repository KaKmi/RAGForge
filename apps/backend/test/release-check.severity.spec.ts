import { ReleaseCheckIssueSchema } from "@codecrush/contracts";
import {
  hasBlockingIssue,
  normalizeIssueSeverity,
} from "../src/modules/applications/release-check.severity";

describe("ReleaseCheckIssue severity", () => {
  it("旧数据没有 severity 字段时解析为 error（向后兼容）", () => {
    const parsed = ReleaseCheckIssueSchema.parse({
      code: "NO_KB",
      message: "至少需要一个知识库",
    });
    expect(parsed.severity).toBe("error");
  });

  it("显式 warning 被保留", () => {
    const parsed = ReleaseCheckIssueSchema.parse({
      code: "EVAL_GATE_REGRESSION",
      message: "存在 5 条回退用例",
      severity: "warning",
    });
    expect(parsed.severity).toBe("warning");
  });

  it("只有非 warning 级 issue 才算阻断", () => {
    expect(hasBlockingIssue([])).toBe(false);
    expect(
      hasBlockingIssue([
        { code: "EVAL_GATE_REGRESSION", message: "存在 5 条回退用例", severity: "warning" },
      ]),
    ).toBe(false);
    expect(
      hasBlockingIssue([{ code: "NO_KB", message: "至少需要一个知识库", severity: "error" }]),
    ).toBe(true);
    // 混合：有 error 即阻断
    expect(
      hasBlockingIssue([
        { code: "EVAL_GATE_REGRESSION", message: "存在 5 条回退用例", severity: "warning" },
        { code: "NO_KB", message: "至少需要一个知识库", severity: "error" },
      ]),
    ).toBe(true);
  });

  /**
   * 【安全方向的回归钉，勿删】
   * toReleaseCheck 是手写映射（applications.service.ts:518-533，:525 `issues: row.issues`），
   * 响应**不过 Zod** ⇒ 库中历史行与 API 响应的 severity 就是 undefined。
   * 判据若写成 `=== "error"`，历史 issue 会静默失去阻断力。必须用排除法。
   */
  it("severity 缺失（历史行/未过 Zod 的响应）必须算阻断", () => {
    const legacy = [{ code: "NO_KB", message: "至少需要一个知识库" }] as unknown as Parameters<
      typeof hasBlockingIssue
    >[0];
    expect(hasBlockingIssue(legacy)).toBe(true);
  });

  /**
   * 【纵深防御钉，勿删】
   * toReleaseCheck 的手写映射把库中历史 jsonb 行原样透出（severity 为 undefined），
   * 前端要按 severity 分区渲染，拿到 undefined 会落进模糊地带。响应边界必须补默认 error。
   * 注意这**不**允许下游改用白名单判据——本函数只覆盖 toReleaseCheck 一个出口。
   */
  it("normalizeIssueSeverity 把历史行的缺失 severity 补成 error，warning 不被改写", () => {
    const legacy = [
      { code: "NO_KB", message: "至少需要一个知识库" },
      { code: "EVAL_GATE_REGRESSION", message: "存在 5 条回退用例", severity: "warning" },
    ] as unknown as Parameters<typeof normalizeIssueSeverity>[0];
    const normalized = normalizeIssueSeverity(legacy);
    expect(normalized[0].severity).toBe("error");
    expect(normalized[1].severity).toBe("warning");
    // 补默认后阻断判据结论不变（排除法本就把 undefined 算作阻断）
    expect(hasBlockingIssue(normalized)).toBe(hasBlockingIssue(legacy));
  });
});
