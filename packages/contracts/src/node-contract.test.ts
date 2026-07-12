import { describe, expect, it } from "vitest";
import {
  compilePromptBody,
  NODE_CONTRACT_VERSION,
  NODE_CONTRACTS,
  PromptNodeSchema,
  type CompileIssue,
  type PromptNode,
} from "./node-contract";
import { extractVars } from "./prompt-template";

describe("NODE_CONTRACTS 静态字段表", () => {
  it("覆盖四个固定节点，与 PromptNodeSchema 枚举一致", () => {
    expect(Object.keys(NODE_CONTRACTS).sort()).toEqual([...PromptNodeSchema.options].sort());
  });

  // 012 §5 权威字段表逐节点断言
  it.each([
    ["rewrite", ["query", "history"], []],
    ["intent", ["query", "history"], ["availableRoutes"]],
    ["reply", ["query", "history", "retrievalContext"], ["citations"]],
    ["fallback", [], []],
  ] as const)("%s 节点字段表对齐 012", (node, templateFields, reservedFields) => {
    expect(NODE_CONTRACTS[node].templateFields).toEqual(templateFields);
    expect(NODE_CONTRACTS[node].reservedFields).toEqual(reservedFields);
  });

  it("当前静态契约版本为 1", () => {
    expect(NODE_CONTRACT_VERSION).toBe(1);
  });
});

describe("compilePromptBody · 合法输入", () => {
  it("空 body 返回 ok（草稿允许保存，不阻断）", () => {
    expect(compilePromptBody("", "reply")).toEqual({ status: "ok", issues: [] });
  });

  it("无占位符纯文本返回 ok", () => {
    expect(compilePromptBody("请礼貌回答用户问题。", "fallback")).toEqual({
      status: "ok",
      issues: [],
    });
  });

  it.each([
    ["rewrite", "结合 {history} 改写 {query}"],
    ["intent", "根据 {history} 判断 {query} 意图"],
    ["reply", "依据 {retrievalContext} 回答 {query}，参考 {history}"],
    ["fallback", "固定兜底话术"],
  ] as const)("%s 节点引用本节点合法字段返回 ok", (node, body) => {
    expect(compilePromptBody(body, node)).toEqual({ status: "ok", issues: [] });
  });
});

describe("compilePromptBody · 模板语法错误", () => {
  it("未闭合的 { 报 INVALID_TEMPLATE_SYNTAX", () => {
    const r = compilePromptBody("回答 {query 的问题", "reply");
    expect(r.status).toBe("has_errors");
    expect(
      r.issues.some((i) => i.code === "INVALID_TEMPLATE_SYNTAX" && i.severity === "error"),
    ).toBe(true);
  });

  it("多余的 } 报 INVALID_TEMPLATE_SYNTAX", () => {
    const r = compilePromptBody("回答 query} 的问题", "reply");
    expect(r.status).toBe("has_errors");
    expect(r.issues.some((i) => i.code === "INVALID_TEMPLATE_SYNTAX")).toBe(true);
  });

  it("嵌套双花括号 {{query}} 报 INVALID_TEMPLATE_SYNTAX", () => {
    const r = compilePromptBody("回答 {{query}} 的问题", "reply");
    expect(r.status).toBe("has_errors");
    expect(r.issues.some((i) => i.code === "INVALID_TEMPLATE_SYNTAX")).toBe(true);
  });
});

describe("compilePromptBody · 字段归属错误", () => {
  it("引用保留字段报 RESERVED_FIELD（intent 的 availableRoutes）", () => {
    const r = compilePromptBody("路由表：{availableRoutes}", "intent");
    expect(r.status).toBe("has_errors");
    const issue = r.issues.find((i) => i.code === "RESERVED_FIELD");
    expect(issue?.severity).toBe("error");
    expect(issue?.field).toBe("availableRoutes");
  });

  it("引用保留字段报 RESERVED_FIELD（reply 的 citations）", () => {
    const r = compilePromptBody("引用：{citations}", "reply");
    expect(r.issues.find((i) => i.code === "RESERVED_FIELD")?.field).toBe("citations");
  });

  it("保留字段跨节点引用同样报 RESERVED_FIELD（全局不可引用类，非 FIELD_NOT_AVAILABLE）", () => {
    const r1 = compilePromptBody("{availableRoutes}", "rewrite");
    expect(r1.issues.find((i) => i.field === "availableRoutes")?.code).toBe("RESERVED_FIELD");
    const r2 = compilePromptBody("{citations}", "fallback");
    expect(r2.issues.find((i) => i.field === "citations")?.code).toBe("RESERVED_FIELD");
  });

  it("引用其他节点字段报 FIELD_NOT_AVAILABLE_FOR_NODE，message 指明归属节点", () => {
    // retrievalContext 只属于 reply；在 rewrite 里引用应报错并说明
    const r = compilePromptBody("{query} {retrievalContext}", "rewrite");
    expect(r.status).toBe("has_errors");
    const issue = r.issues.find((i) => i.code === "FIELD_NOT_AVAILABLE_FOR_NODE");
    expect(issue?.field).toBe("retrievalContext");
    expect(issue?.message).toContain("reply");
  });

  it("reason 已从纯文本 fallback 契约移除，所有节点均报 UNKNOWN_VARIABLE", () => {
    const r = compilePromptBody("{reason}", "reply");
    expect(r.issues.find((i) => i.code === "UNKNOWN_VARIABLE")?.field).toBe("reason");
  });

  it("fallback 不接受任何模板字段", () => {
    const r = compilePromptBody("抱歉，无法回答 {query}", "fallback");
    expect(r.status).toBe("has_errors");
    expect(r.issues.find((i) => i.code === "FIELD_NOT_AVAILABLE_FOR_NODE")?.field).toBe("query");
  });

  it("未知字段报 UNKNOWN_VARIABLE", () => {
    const r = compilePromptBody("{totally_unknown_field}", "reply");
    expect(r.status).toBe("has_errors");
    const issue = r.issues.find((i) => i.code === "UNKNOWN_VARIABLE");
    expect(issue?.field).toBe("totally_unknown_field");
    expect(issue?.suggestion).toBeUndefined();
  });

  it("拼写接近合法字段时带一键修复 suggestion", () => {
    const r = compilePromptBody("{qeury}", "reply");
    const issue = r.issues.find((i) => i.code === "UNKNOWN_VARIABLE");
    expect(issue?.suggestion).toBe("query");
  });

  it("大小写不同视为拼写接近（Query → query）", () => {
    const r = compilePromptBody("{Query}", "reply");
    const issue = r.issues.find((i) => i.code === "UNKNOWN_VARIABLE");
    expect(issue?.suggestion).toBe("query");
  });
});

describe("compilePromptBody · 重复警告", () => {
  it("同一字段短距离内出现 ≥3 次报 MESSY_DUPLICATE 警告", () => {
    const r = compilePromptBody("{query} {query} {query}", "reply");
    expect(r.status).toBe("has_warnings");
    const issue = r.issues.find((i) => i.code === "MESSY_DUPLICATE");
    expect(issue?.severity).toBe("warning");
  });

  it("整行内容重复报 MESSY_DUPLICATE 警告", () => {
    const r = compilePromptBody("请不要编造内容。\n回答 {query}\n请不要编造内容。", "reply");
    expect(r.status).toBe("has_warnings");
    expect(r.issues.some((i) => i.code === "MESSY_DUPLICATE")).toBe(true);
  });

  it("同一字段分散出现 2 次不告警", () => {
    expect(compilePromptBody("{query} 与 {query}", "reply").status).toBe("ok");
  });

  it("错误与警告并存时 status 为 has_errors", () => {
    const r = compilePromptBody("{query} {query} {query} {unknown_x}", "reply");
    expect(r.status).toBe("has_errors");
    expect(r.issues.some((i) => i.severity === "warning")).toBe(true);
    expect(r.issues.some((i) => i.severity === "error")).toBe(true);
  });
});

describe("compilePromptBody · 顺序稳定性与 extractVars 兼容", () => {
  it("issues 顺序稳定：语法错误在前，字段错误按正文出现顺序，警告最后", () => {
    const body = "{unknown_b} {availableRoutes} {unknown_a} 残缺 {";
    const r1 = compilePromptBody(body, "intent");
    const r2 = compilePromptBody(body, "intent");
    expect(r1).toEqual(r2);
    const codes = r1.issues.map((i: CompileIssue) => i.code);
    expect(codes[0]).toBe("INVALID_TEMPLATE_SYNTAX");
    const fieldOrder = r1.issues.filter((i) => i.field).map((i) => i.field);
    expect(fieldOrder).toEqual(["unknown_b", "availableRoutes", "unknown_a"]);
  });

  it("字段发现与 extractVars 一致（同一正则语义，非 \\w 内容不算占位符）", () => {
    const body = "{query} {不算变量} {retrievalContext}";
    const vars = extractVars(body);
    expect(vars).toEqual(["query", "retrievalContext"]);
    // compile 对 {不算变量} 不报 UNKNOWN_VARIABLE（与 extractVars 的占位符定义一致）
    expect(compilePromptBody(body, "reply")).toEqual({ status: "ok", issues: [] });
  });

  it("每个问题字段只报一次（重复引用未知字段不刷屏）", () => {
    const r = compilePromptBody("{unknown_x} {unknown_x}", "reply");
    expect(r.issues.filter((i) => i.code === "UNKNOWN_VARIABLE")).toHaveLength(1);
  });
});

describe("compilePromptBody · 跨节点表驱动", () => {
  // 每个节点引用其余节点的可引用字段 → FIELD_NOT_AVAILABLE_FOR_NODE（防字段表漂移）
  const foreignTemplate: Record<PromptNode, string[]> = {
    rewrite: ["retrievalContext"],
    intent: ["retrievalContext"],
    reply: [],
    fallback: ["history", "retrievalContext"],
  };
  it.each(Object.entries(foreignTemplate) as [PromptNode, string[]][])(
    "%s 节点引用外部可引用字段报 FIELD_NOT_AVAILABLE_FOR_NODE",
    (node, foreign) => {
      for (const f of foreign) {
        const r = compilePromptBody(`{${f}}`, node);
        expect(r.status).toBe("has_errors");
        expect(r.issues.find((i) => i.field === f)?.code).toBe("FIELD_NOT_AVAILABLE_FOR_NODE");
      }
    },
  );

  // 任何节点引用任何保留字段 → 一律 RESERVED_FIELD
  it.each(PromptNodeSchema.options.map((n) => [n] as const))(
    "%s 节点引用保留字段一律报 RESERVED_FIELD",
    (node) => {
      for (const reserved of ["availableRoutes", "citations"]) {
        const r = compilePromptBody(`{${reserved}}`, node);
        expect(r.status).toBe("has_errors");
        expect(r.issues.find((i) => i.field === reserved)?.code).toBe("RESERVED_FIELD");
      }
    },
  );
});
