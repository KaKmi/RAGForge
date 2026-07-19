import type { ReleaseCheckIssue } from "@codecrush/contracts";

/**
 * 「阻断」的唯一判据。B1/F5 之前是「issues 非空即 failed」，
 * 现在改为「存在非 warning 级才 failed」——评测门禁的 warning 不得阻断发布（软提示）。
 *
 * **必须是排除法（!== "warning"），不能是白名单（=== "error"）**：
 * toReleaseCheck 是逐字段手写映射（applications.service.ts:518-533），
 * 第 525 行 `issues: row.issues` 原样透出，**响应与库中历史行都不过 Zod**
 * ⇒ 它们的 severity 是 undefined。用白名单会把历史的静态门禁失败判成非阻断，
 * 一条真实的阻断 issue 静默失去阻断力——安全方向的回归。
 * undefined 必须落在「阻断」一侧。
 */
export function hasBlockingIssue(issues: readonly ReleaseCheckIssue[]): boolean {
  return issues.some((issue) => issue.severity !== "warning");
}

/**
 * 纵深防御（**不替代** `hasBlockingIssue` 的排除法）：`toReleaseCheck`
 * （applications.service.ts:518-533，第 525 行 `issues: row.issues`）是逐字段手写映射，
 * 库中 M7b 时代写入的 jsonb 行没有 `severity` 且**不过 Zod** ⇒ 原样透出就是 `undefined`。
 * 前端要按 severity 分区渲染（warning=评测提示、error=阻断），拿到 `undefined` 会落进
 * 「既不是 warning 也没显式 error」的模糊地带。故在响应边界把缺失值补成 `error`——
 * 与 Zod `.default("error")` 同一口径，语义零变化（排除法下 undefined 本就算阻断）。
 *
 * ⚠️ 补这一层**不意味着**下游可以改用白名单 `=== "error"`：本函数只覆盖
 * `toReleaseCheck` 这一个出口，任何绕过它直接读 `row.issues` 的路径仍会拿到 `undefined`。
 */
export function normalizeIssueSeverity(
  issues: readonly ReleaseCheckIssue[],
): ReleaseCheckIssue[] {
  return issues.map((issue) => {
    // `as Partial<...>` 不是多余的：z.infer 把带 .default() 的字段推成**必填**，
    // 于是 TS 认为 `issue.severity` 恒真、这个分支恒不成立——一次
    // `no-unnecessary-condition` 之类的清理就会把它删掉。类型是编译期的谎言，
    // 运行期这里拿到的是未过 Zod 的库中 jsonb。强制转换把这个落差写进代码本身。
    const severity = (issue as Partial<ReleaseCheckIssue>).severity ?? "error";
    return { ...issue, severity };
  });
}
