import { hardSplitByTokens } from "../src/modules/ingestion/pipeline/hard-split";
import { estimateTokens } from "../src/modules/ingestion/pipeline/estimate-tokens";

describe("hardSplitByTokens（embedding 单条输入硬上限保护）", () => {
  it("不超限的文本原样返回单元素", () => {
    expect(hardSplitByTokens("短文本。", 512)).toEqual(["短文本。"]);
  });

  it("超长中文段落按句子边界切分，每片 ≤ 上限且内容零丢失", () => {
    // 100 句 × 20 字 ≈ 2000 token，上限 512 → 至少 4 片
    const sentence = "苏州工业园区房价近三年走势平稳略有回升。";
    const text = sentence.repeat(100);
    const pieces = hardSplitByTokens(text, 512);

    expect(pieces.length).toBeGreaterThanOrEqual(4);
    for (const p of pieces) {
      expect(estimateTokens(p)).toBeLessThanOrEqual(512);
    }
    // 内容零丢失（trim 不影响无空白的中文串）
    expect(pieces.join("")).toBe(text);
    // 句子边界优先：每片都以句号结尾（本用例每句等长，永远可在句边界断开）
    for (const p of pieces) {
      expect(p.endsWith("。")).toBe(true);
    }
  });

  it("无标点超长串回退字符级强切，每片 ≤ 上限且内容零丢失", () => {
    const text = "字".repeat(1500); // 无任何句读
    const pieces = hardSplitByTokens(text, 512);
    expect(pieces.length).toBe(3); // 512 + 512 + 476
    for (const p of pieces) {
      expect(estimateTokens(p)).toBeLessThanOrEqual(512);
    }
    expect(pieces.join("")).toBe(text);
  });

  it("英文长文按 4 字符≈1 token 估算切分，每片 ≤ 上限", () => {
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(300); // ~3400 token
    const pieces = hardSplitByTokens(text, 512);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      expect(estimateTokens(p)).toBeLessThanOrEqual(512);
    }
  });
});
