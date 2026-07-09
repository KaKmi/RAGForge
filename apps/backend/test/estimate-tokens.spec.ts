import { estimateTokens } from "../src/modules/ingestion/pipeline/estimate-tokens";

describe("estimateTokens", () => {
  it("纯 ASCII：约 4 字符 = 1 token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(40))).toBe(10);
  });
  it("纯中文：1 字符 = 1 token", () => {
    expect(estimateTokens("你好世界")).toBe(4);
  });
  it("混合文本：中文按字符 + 英文按 4 字符折算，向上取整", () => {
    expect(estimateTokens("你好abcd")).toBe(3); // 2(中文) + ceil(4/4)=1
  });
  it("空字符串为 0", () => {
    expect(estimateTokens("")).toBe(0);
  });
});
