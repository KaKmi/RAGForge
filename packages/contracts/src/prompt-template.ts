// 前后端共享的 Prompt 模板纯逻辑（003 §Isomorphic）
// 零运行时依赖，仅靠 JS 正则与数组；前端打包安全。
const VAR_RE = /\{(\w+)\}/g;

/** 从模板正文中抽取 {var} 占位符，去重并保留首次出现顺序。 */
export function extractVars(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of body?.matchAll?.(VAR_RE) ?? []) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

/** 用 vars 填充 {var}；未知变量保留原占位符（不抛错，供预览/预演）。 */
export function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(VAR_RE, (_, k: string) => vars[k] ?? `{${k}}`);
}

export type DiffLine = { type: "same" | "add" | "del"; text: string };

/**
 * 两段 Prompt 正文按行做 LCS diff，返回逐行差异。
 * 用于版本对比视图（add/del/same 三态着色）。
 */
export function diffPromptBodies(a: string, b: string): DiffLine[] {
  const A = (a || "").split("\n");
  const B = (b || "").split("\n");
  const m = A.length;
  const n = B.length;
  // dp[i][j] = A[i:] 与 B[j:] 的 LCS 长度
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) {
      out.push({ type: "same", text: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: A[i] });
      i++;
    } else {
      out.push({ type: "add", text: B[j] });
      j++;
    }
  }
  while (i < m) out.push({ type: "del", text: A[i++] });
  while (j < n) out.push({ type: "add", text: B[j++] });
  return out;
}
