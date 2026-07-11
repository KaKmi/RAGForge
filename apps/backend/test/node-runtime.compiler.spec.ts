import { renderTemplateStrict } from "../src/modules/node-runtime/compiler/render-strict";
import { assembleMessages } from "../src/modules/node-runtime/compiler/assemble";
import { REWRITE_CONTRACT } from "../src/modules/node-runtime/contracts/rewrite.contract";
import { INTENT_CONTRACT } from "../src/modules/node-runtime/contracts/intent.contract";

// M8.0 Story 6：严格渲染（区别于 contracts 包宽松版 renderTemplate，注释明确
// "只适用于预览"）+ 三层消息组装（system 固定 + developer 渲染结果 + user JSON envelope）。

describe("renderTemplateStrict", () => {
  it("合法变量：正常替换", () => {
    expect(renderTemplateStrict("回答 {query}", { query: "q" }, "rewrite")).toBe("回答 q");
  });
  it("未知变量：抛错（严格渲染，区别于 contracts 包宽松版 renderTemplate）", () => {
    expect(() => renderTemplateStrict("{notAField}", {}, "rewrite")).toThrow();
  });
  it("保留字段：抛错", () => {
    expect(() => renderTemplateStrict("{availableRoutes}", {}, "intent")).toThrow();
  });
  it("多个合法变量：全部替换，未提供的变量用空串", () => {
    expect(renderTemplateStrict("{query} / {history}", { query: "q" }, "rewrite")).toBe("q / ");
  });
  it("其他节点的合法字段在本节点视角下仍是非法（如 reply 的 retrievalContext 用在 rewrite 上）", () => {
    expect(() => renderTemplateStrict("{retrievalContext}", {}, "rewrite")).toThrow();
  });
  it("跨节点的保留字段同样抛错（如 reply 的保留字段 citations 用在 rewrite 模板里，review round 1）", () => {
    expect(() => renderTemplateStrict("{citations}", {}, "rewrite")).toThrow();
  });
});

describe("assembleMessages", () => {
  it("三层顺序：system 固定 → developer 渲染结果 → user JSON envelope", () => {
    const messages = assembleMessages({
      contract: REWRITE_CONTRACT,
      promptBody: "改写：{query}",
      input: { query: "怎么退货", history: "" },
      reserved: {},
    });
    expect(messages[0]).toEqual({ role: "system", content: REWRITE_CONTRACT.systemInstructions });
    expect(messages[1]).toEqual({ role: "developer", content: "改写：怎么退货" });
    expect(messages[2].role).toBe("user");
    expect(JSON.parse(messages[2].content)).toEqual({ query: "怎么退货", history: "" });
  });

  it("user envelope 包含 input 与 reserved 的合并（reserved 字段一并透传给模型，用真实带 reservedDataSchema 的 INTENT_CONTRACT 而非 rewrite 的空 schema，review round 1）", () => {
    const messages = assembleMessages({
      contract: INTENT_CONTRACT,
      promptBody: "{query}",
      input: { query: "q", history: "h" },
      reserved: { availableRoutes: ["kb_a", "kb_b"] },
    });
    expect(JSON.parse(messages[2].content)).toEqual({
      query: "q",
      history: "h",
      availableRoutes: ["kb_a", "kb_b"],
    });
  });

  it("input 与 reserved 同名字段冲突时 reserved 胜出（平台注入优先于用户输入，review round 1）", () => {
    const messages = assembleMessages({
      contract: INTENT_CONTRACT,
      promptBody: "{query}",
      // 人为构造同名字段冲突（真实 Contract 目前不产生这种冲突，此处专测 spread 优先级本身）
      input: { query: "q", history: "h", availableRoutes: ["untrusted-from-input"] } as never,
      reserved: { availableRoutes: ["kb_trusted"] },
    });
    expect(JSON.parse(messages[2].content).availableRoutes).toEqual(["kb_trusted"]);
  });

  it("恰好三条消息，顺序固定", () => {
    const messages = assembleMessages({
      contract: REWRITE_CONTRACT,
      promptBody: "{query}",
      input: { query: "q", history: "" },
      reserved: {},
    });
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.role)).toEqual(["system", "developer", "user"]);
  });
});
