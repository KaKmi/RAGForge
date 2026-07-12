import { z } from "zod";
import { extractVars } from "./prompt-template";

// NodeContract 静态字段契约（012 §5）：四固定节点的字段名表 + 编辑期编译规则。
// 纯函数/纯数据，零 Node-only 依赖——前端编辑器本地实时红线、后端保存版本时
// 持久化 compile_status/compile_errors 共用同一实现（012 Invariant 4「预览等于运行时」）。
// 执行契约（outputSchema/修复重试/fallback）属 011 node-runtime 域，不在本文件。

// PromptNodeSchema 定义在此（而非 prompts.ts）：prompts.ts 依赖本文件的编译结果 schema，
// 依赖方向收敛为 prompts → node-contract → prompt-template，避免循环 import。
export const PromptNodeSchema = z.enum(["rewrite", "intent", "reply", "fallback"]);
export type PromptNode = z.infer<typeof PromptNodeSchema>;

// 节点生成自由度预设（precise/balance/improvise 预设温度/TopP，custom 解锁微调）。
// M7b S8：从 agents.ts 迁至此叶子——applications/agents 都消费它，属节点配置共享概念，
// 不该让 applications → agents 反向依赖（agents 是待下线的旧域）。agents.ts 改为从此 import。
export const FreedomSchema = z.enum(["precise", "balance", "improvise", "custom"]);
export type Freedom = z.infer<typeof FreedomSchema>;

/** 当前静态字段契约版本（001/011 不变量：PromptVersion 固定 contract_version） */
export const NODE_CONTRACT_VERSION = 1;

export interface NodeFieldContract {
  /** 管理员可在正文引用的字段（{field} 占位符） */
  templateFields: readonly string[];
  /** 平台只读注入、不可引用的保留字段 */
  reservedFields: readonly string[];
}

// 012 §5 权威字段表——011 的 NodeContract.templateFields 复用此表，不得另行定义。
export const NODE_CONTRACTS: Record<PromptNode, NodeFieldContract> = {
  rewrite: { templateFields: ["query", "history"], reservedFields: [] },
  intent: { templateFields: ["query", "history"], reservedFields: ["availableRoutes"] },
  reply: {
    templateFields: ["query", "history", "retrievalContext"],
    reservedFields: ["citations"],
  },
  // fallback 是版本化纯文本：正文即最终返回内容，不接受运行时模板字段。
  fallback: { templateFields: [], reservedFields: [] },
};

export const CompileStatusSchema = z.enum(["ok", "has_errors", "has_warnings"]);
export type CompileStatus = z.infer<typeof CompileStatusSchema>;

export const CompileIssueCodeSchema = z.enum([
  "INVALID_TEMPLATE_SYNTAX",
  "RESERVED_FIELD",
  "FIELD_NOT_AVAILABLE_FOR_NODE",
  "UNKNOWN_VARIABLE",
  "MESSY_DUPLICATE",
]);
export type CompileIssueCode = z.infer<typeof CompileIssueCodeSchema>;

export const CompileIssueSchema = z.object({
  code: CompileIssueCodeSchema,
  severity: z.enum(["error", "warning"]),
  message: z.string(),
  /** 涉及的字段名（语法类问题无字段） */
  field: z.string().optional(),
  /** 「一键改为 {x}」修复建议的目标字段名 */
  suggestion: z.string().optional(),
});
export type CompileIssue = z.infer<typeof CompileIssueSchema>;

export const CompileResultSchema = z.object({
  status: CompileStatusSchema,
  issues: z.array(CompileIssueSchema),
});
export type CompileResult = z.infer<typeof CompileResultSchema>;

// 同一字段在 200 字符窗口内出现 ≥3 次视为「疑似重复粘贴」（012 §5 MESSY_DUPLICATE）
const DUPLICATE_WINDOW_CHARS = 200;
const DUPLICATE_MIN_OCCURRENCES = 3;
// 拼写建议的最大编辑距离（qeury→query 为 2 内的换位/替换）
const SUGGESTION_MAX_DISTANCE = 2;

/**
 * 编辑期编译（012 §5 规则表）。所有情形都允许保存（含空 body 与错误），
 * 生产阻断由应用发布门禁（009）消费本结果另行判定。
 * issues 顺序稳定：语法错误 → 字段问题（按正文首次出现序）→ 重复警告。
 */
export function compilePromptBody(body: string, node: PromptNode): CompileResult {
  const issues: CompileIssue[] = [];
  const text = body ?? "";

  issues.push(...checkBraceSyntax(text));
  issues.push(...checkFields(text, node));
  issues.push(...checkDuplicates(text));

  const status: CompileStatus = issues.some((i) => i.severity === "error")
    ? "has_errors"
    : issues.some((i) => i.severity === "warning")
      ? "has_warnings"
      : "ok";
  return { status, issues };
}

// 花括号扫描：不匹配 / 嵌套双花括号 → INVALID_TEMPLATE_SYNTAX。
// 每种问题只报一次（不按出现次数刷屏）。
function checkBraceSyntax(text: string): CompileIssue[] {
  let depth = 0;
  let nested = false;
  let unmatchedClose = false;
  for (const ch of text) {
    if (ch === "{") {
      depth++;
      if (depth > 1) nested = true;
    } else if (ch === "}") {
      if (depth === 0) unmatchedClose = true;
      else depth--;
    }
  }
  const out: CompileIssue[] = [];
  if (nested) {
    out.push({
      code: "INVALID_TEMPLATE_SYNTAX",
      severity: "error",
      message: "嵌套双花括号不是合法占位符，请使用单层 {字段名}",
    });
  }
  if (unmatchedClose) {
    out.push({
      code: "INVALID_TEMPLATE_SYNTAX",
      severity: "error",
      message: "存在未配对的 }，请检查花括号是否成对",
    });
  }
  if (depth > 0) {
    out.push({
      code: "INVALID_TEMPLATE_SYNTAX",
      severity: "error",
      message: "存在未闭合的 {，请检查花括号是否成对",
    });
  }
  return out;
}

// 字段归属检查：占位符定义与 extractVars 完全一致（\w+），非法内容视为普通文本。
// 每个字段只报一次，顺序按正文首次出现。
// 保留字段是全局「永不可引用」类：无论出现在哪个节点都报 RESERVED_FIELD（012 §5），
// 不会被「别的节点的字段」分类抢走。
function checkFields(text: string, node: PromptNode): CompileIssue[] {
  const contract = NODE_CONTRACTS[node];
  const legal = new Set(contract.templateFields);
  const out: CompileIssue[] = [];
  for (const field of extractVars(text)) {
    if (legal.has(field)) continue;
    if (isReservedField(field)) {
      out.push({
        code: "RESERVED_FIELD",
        severity: "error",
        message: `{${field}} 是平台只读注入的保留字段，不能在正文中引用`,
        field,
      });
      continue;
    }
    const owner = findOwnerNode(field, node);
    if (owner) {
      out.push({
        code: "FIELD_NOT_AVAILABLE_FOR_NODE",
        severity: "error",
        message: `{${field}} 属于 ${owner} 节点，当前节点不可引用`,
        field,
      });
      continue;
    }
    const suggestion = suggestField(field, contract.templateFields);
    out.push({
      code: "UNKNOWN_VARIABLE",
      severity: "error",
      message: suggestion
        ? `未知字段 {${field}}，是否想用 {${suggestion}}？`
        : `未知字段 {${field}}，该节点可用：${contract.templateFields.map((f) => `{${f}}`).join(" ")}`,
      field,
      ...(suggestion ? { suggestion } : {}),
    });
  }
  return out;
}

/** 任一节点的保留字段命中即视为保留（全局不可引用类） */
function isReservedField(field: string): boolean {
  return PromptNodeSchema.options.some((key) => NODE_CONTRACTS[key].reservedFields.includes(field));
}

/** 字段是其他节点的可引用字段时返回节点 key（保留字段已在前一分支收口） */
function findOwnerNode(field: string, exclude: PromptNode): PromptNode | undefined {
  for (const key of PromptNodeSchema.options) {
    if (key === exclude) continue;
    if (NODE_CONTRACTS[key].templateFields.includes(field)) return key;
  }
  return undefined;
}

/** 拼写接近的合法字段建议：大小写不敏感 + 编辑距离 ≤2；平手取字段表序 */
function suggestField(field: string, candidates: readonly string[]): string | undefined {
  const lower = field.toLowerCase();
  let best: string | undefined;
  let bestDist = SUGGESTION_MAX_DISTANCE + 1;
  for (const c of candidates) {
    const dist = levenshtein(lower, c.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return bestDist <= SUGGESTION_MAX_DISTANCE ? best : undefined;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i, ...new Array<number>(n).fill(0)];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// 重复检查（警告，非错误）：整行内容重复 / 同一字段短距离内 ≥3 次。各报一次。
function checkDuplicates(text: string): CompileIssue[] {
  const out: CompileIssue[] = [];

  const lineSeen = new Map<string, number>();
  let duplicatedLine: string | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const count = (lineSeen.get(line) ?? 0) + 1;
    lineSeen.set(line, count);
    if (count >= 2 && duplicatedLine === undefined) duplicatedLine = line;
  }

  const positions = new Map<string, number[]>();
  const VAR_RE = /\{(\w+)\}/g;
  for (const m of text.matchAll(VAR_RE)) {
    const list = positions.get(m[1]) ?? [];
    list.push(m.index ?? 0);
    positions.set(m[1], list);
  }
  let crowdedField: string | undefined;
  for (const [field, pos] of positions) {
    for (let i = 0; i + DUPLICATE_MIN_OCCURRENCES - 1 < pos.length; i++) {
      if (pos[i + DUPLICATE_MIN_OCCURRENCES - 1] - pos[i] <= DUPLICATE_WINDOW_CHARS) {
        crowdedField = field;
        break;
      }
    }
    if (crowdedField) break;
  }

  if (crowdedField) {
    out.push({
      code: "MESSY_DUPLICATE",
      severity: "warning",
      message: `{${crowdedField}} 在短距离内重复出现，疑似重复粘贴`,
      field: crowdedField,
    });
  }
  if (duplicatedLine !== undefined) {
    out.push({
      code: "MESSY_DUPLICATE",
      severity: "warning",
      message: "存在整行重复的内容，疑似重复粘贴",
    });
  }
  return out;
}
