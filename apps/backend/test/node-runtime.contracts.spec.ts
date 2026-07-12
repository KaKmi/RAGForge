import { NODE_CONTRACTS } from "@codecrush/contracts";
import { REWRITE_CONTRACT } from "../src/modules/node-runtime/contracts/rewrite.contract";
import { INTENT_CONTRACT } from "../src/modules/node-runtime/contracts/intent.contract";
import { REPLY_CONTRACT } from "../src/modules/node-runtime/contracts/reply.contract";
import { FALLBACK_CONTRACT } from "../src/modules/node-runtime/contracts/fallback.contract";
import { NodeContractRegistry } from "../src/modules/node-runtime/contracts/registry";

// M8.0 Story 5：四节点 NodeContract v1 内容逐字取自 011 Design §1，
// templateFields 复用 012 静态字段契约（NODE_CONTRACTS），不重新定义字段名。

describe("REWRITE_CONTRACT", () => {
  it("fallback：直接用原始 query，keywords 置空", () => {
    const out = REWRITE_CONTRACT.fallback({ query: "怎么退货", history: "" }, {});
    expect(out).toEqual({ rewrittenQuery: "怎么退货", keywords: [] });
  });
  it("outputSchema 拒绝空 rewrittenQuery", () => {
    expect(
      REWRITE_CONTRACT.outputSchema.safeParse({ rewrittenQuery: "", keywords: [] }).success,
    ).toBe(false);
  });
  it("outputSchema 接受合法输出", () => {
    expect(
      REWRITE_CONTRACT.outputSchema.safeParse({ rewrittenQuery: "改写后的问题", keywords: ["a"] })
        .success,
    ).toBe(true);
  });
  it("inputSchema 拒绝空 query", () => {
    expect(REWRITE_CONTRACT.inputSchema.safeParse({ query: "", history: "" }).success).toBe(false);
  });
  it("reservedDataSchema 接受调用方传入的共享 RuntimeContext 多余字段（如 preview），不因非 .strict() 拒绝（review round 2）", () => {
    const check = REWRITE_CONTRACT.reservedDataSchema.safeParse({ preview: true });
    expect(check.success).toBe(true);
  });
});

// review round 1：原测试用 toEqual 对比硬编码字面量，测不出"复用同一份表 vs
// 重新拷贝了一份相同内容的字面量"——后者正是 011/012 明确禁止的字段名漂移风险。
// 用 toBe（引用相等）四节点全覆盖，才能真正断言"同一份表"而非"内容恰好一致"。
describe("templateFields 复用 012 静态字段契约（引用相等，非拷贝，四节点全覆盖）", () => {
  it("rewrite/intent/reply/fallback 的 templateFields 与 NODE_CONTRACTS 是同一个数组引用", () => {
    expect(REWRITE_CONTRACT.templateFields).toBe(NODE_CONTRACTS.rewrite.templateFields);
    expect(INTENT_CONTRACT.templateFields).toBe(NODE_CONTRACTS.intent.templateFields);
    expect(REPLY_CONTRACT.templateFields).toBe(NODE_CONTRACTS.reply.templateFields);
    expect(FALLBACK_CONTRACT.templateFields).toBe(NODE_CONTRACTS.fallback.templateFields);
  });
});

describe("INTENT_CONTRACT", () => {
  it("fallback：intent=unknown，routeIds 置空，confidence=0", () => {
    const out = INTENT_CONTRACT.fallback(
      { query: "q", history: "" },
      { availableRoutes: ["kb_a"] },
    );
    expect(out).toEqual({ intent: "unknown", routeIds: [], confidence: 0 });
  });
  it("extraValidate：routeIds 越权（不在 availableRoutes 里）→ 返回 issue", () => {
    const issues = INTENT_CONTRACT.extraValidate!(
      { intent: "售后", routeIds: ["kb_illegal"], confidence: 0.9 },
      { availableRoutes: ["kb_a"] },
    );
    expect(issues.length).toBeGreaterThan(0);
  });
  it("extraValidate：routeIds 全部合法 → 无 issue", () => {
    const issues = INTENT_CONTRACT.extraValidate!(
      { intent: "售后", routeIds: ["kb_a"], confidence: 0.9 },
      { availableRoutes: ["kb_a"] },
    );
    expect(issues).toEqual([]);
  });
  it("outputSchema 拒绝 confidence 超出 0-1 范围", () => {
    expect(
      INTENT_CONTRACT.outputSchema.safeParse({ intent: "售后", routeIds: [], confidence: 1.5 })
        .success,
    ).toBe(false);
  });
  it("outputSchema 拒绝非法 intent 枚举值", () => {
    expect(
      INTENT_CONTRACT.outputSchema.safeParse({ intent: "其它", routeIds: [], confidence: 0.5 })
        .success,
    ).toBe(false);
  });
});

describe("REPLY_CONTRACT / FALLBACK_CONTRACT", () => {
  it("reply 的 runtimeMode 是 stream", () => {
    expect(REPLY_CONTRACT.runtimeMode).toBe("stream");
  });
  it("reply outputSchema 拒绝空文本", () => {
    expect(REPLY_CONTRACT.outputSchema.safeParse({ text: "" }).success).toBe(false);
  });
  it("fallback 节点的 fallback() 仅为空正文异常路径提供平台保底文案", () => {
    const out = FALLBACK_CONTRACT.fallback({}, {});
    expect(out.text.length).toBeGreaterThan(0);
    const out2 = FALLBACK_CONTRACT.fallback({}, {});
    expect(out2.text).toBe(out.text);
  });
  it("fallback 节点 runtimeMode 是 stream 且标记 last:true", () => {
    expect(FALLBACK_CONTRACT.runtimeMode).toBe("stream");
    expect(FALLBACK_CONTRACT.last).toBe(true);
  });
  it("fallback 节点 reservedDataSchema 同样接受共享 RuntimeContext 多余字段（review round 2）", () => {
    expect(FALLBACK_CONTRACT.reservedDataSchema.safeParse({ preview: true }).success).toBe(true);
  });
});

describe("NodeContractRegistry", () => {
  it("resolve('rewrite', 1) 返回 REWRITE_CONTRACT", () => {
    expect(NodeContractRegistry.resolve("rewrite", 1)).toBe(REWRITE_CONTRACT);
  });
  it("resolve('intent'/'reply'/'fallback', 1) 分别返回对应 Contract", () => {
    expect(NodeContractRegistry.resolve("intent", 1)).toBe(INTENT_CONTRACT);
    expect(NodeContractRegistry.resolve("reply", 1)).toBe(REPLY_CONTRACT);
    expect(NodeContractRegistry.resolve("fallback", 1)).toBe(FALLBACK_CONTRACT);
  });
  it("resolve 未知 contractVersion → 抛错（011 Failure modes：不允许用最新版本替代）", () => {
    expect(() => NodeContractRegistry.resolve("rewrite", 99)).toThrow();
  });
});
