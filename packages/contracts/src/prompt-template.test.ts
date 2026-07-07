import { describe, expect, it } from "vitest";
import { diffPromptBodies, extractVars, renderTemplate } from "./prompt-template";

describe("extractVars", () => {
  it("去重并保留首次出现顺序", () => {
    expect(extractVars("你好 {query}，{query} 再来 {name}")).toEqual(["query", "name"]);
  });
  it("空串返回空数组", () => {
    expect(extractVars("")).toEqual([]);
  });
  it("无占位符返回空数组", () => {
    expect(extractVars("没有变量的文本")).toEqual([]);
  });
  it("仅识别字母数字下划线变量名（中文等不匹配）", () => {
    expect(extractVars("{a1} {b_2} {中文}")).toEqual(["a1", "b_2"]);
  });
});

describe("renderTemplate", () => {
  it("替换已知变量", () => {
    expect(renderTemplate("你好 {query}", { query: "退货" })).toBe("你好 退货");
  });
  it("未知变量保留原占位符", () => {
    expect(renderTemplate("你好 {query}", {})).toBe("你好 {query}");
  });
  it("多个变量一起替换", () => {
    expect(renderTemplate("{a}+{b}={c}", { a: "1", b: "2", c: "3" })).toBe("1+2=3");
  });
});

describe("diffPromptBodies", () => {
  it("行级 LCS diff（del 中间行 + add 新行 + same 首尾）", () => {
    expect(diffPromptBodies("a\nb\nc", "a\nx\nc")).toEqual([
      { type: "same", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "x" },
      { type: "same", text: "c" },
    ]);
  });
  it("全相同则全部 same", () => {
    expect(diffPromptBodies("a\nb", "a\nb").every((d) => d.type === "same")).toBe(true);
  });
  it("新增行标记为 add", () => {
    expect(diffPromptBodies("a", "a\nb")).toEqual([
      { type: "same", text: "a" },
      { type: "add", text: "b" },
    ]);
  });
});
