import { estimateTokens } from "../src/modules/ingestion/pipeline/estimate-tokens";
import { GeneralChunker } from "../src/modules/ingestion/adapters/chunkers/general-chunker";
import { QaChunker } from "../src/modules/ingestion/adapters/chunkers/qa-chunker";
import { CustomChunker } from "../src/modules/ingestion/adapters/chunkers/custom-chunker";
import { CHUNKER_REGISTRY } from "../src/modules/ingestion/adapters/chunkers/chunker-registry";

describe("CHUNKER_REGISTRY 完整性", () => {
  it("general/qa/custom 三个模板都有实现", () => {
    expect(CHUNKER_REGISTRY.general).toBeInstanceOf(GeneralChunker);
    expect(CHUNKER_REGISTRY.qa).toBeInstanceOf(QaChunker);
    expect(CHUNKER_REGISTRY.custom).toBeInstanceOf(CustomChunker);
  });
});

describe("GeneralChunker", () => {
  const chunker = new GeneralChunker();

  it("按标题层级切段，section 记标题路径", () => {
    const md = "# 一\n段落A\n## 二\n段落B\n段落C";
    const drafts = chunker.chunk(md);
    expect(drafts.length).toBeGreaterThanOrEqual(2);
    expect(drafts[0].section).toBe("一");
    expect(drafts.some((d) => d.section === "一 > 二")).toBe(true);
  });

  it("无标题结构的纯文本退化为整体成段（贪心合并至阈值前保持完整）", () => {
    const drafts = chunker.chunk("普通一段没有标题的文本内容。");
    expect(drafts.length).toBe(1);
    expect(drafts[0].section).toBe("");
  });

  it("首个标题前的引言内容不丢弃：以 seq 0、空 section 先行成段", () => {
    const drafts = chunker.chunk("引言段落。\n# 一\n正文");
    expect(drafts[0]).toEqual({ seq: 0, text: "引言段落。", section: "" });
    expect(drafts.some((d) => d.text.includes("正文") && d.section === "一")).toBe(true);
    expect(drafts.map((d) => d.seq)).toEqual(drafts.map((_, i) => i));
  });

  it("跳级标题不留空路径段：# 直跳 ### 得 'a > c' 而非 'a >  > c'", () => {
    const drafts = chunker.chunk("# a\n### c\n正文");
    expect(drafts.some((d) => d.section === "a > c")).toBe(true);
    expect(drafts.every((d) => !d.section.includes(">  >"))).toBe(true);
  });

  it("seq 从 0 递增且连续", () => {
    const drafts = chunker.chunk("# 一\nA\n# 二\nB\n# 三\nC");
    expect(drafts.map((d) => d.seq)).toEqual(drafts.map((_, i) => i));
  });
});

describe("QaChunker", () => {
  const chunker = new QaChunker();

  it("识别中文问答标记 问：/答： 配对切片", () => {
    const text = "问：如何退款？\n答：七天内可申请。\n问：如何换课？\n答：开课30天内可申请。";
    const drafts = chunker.chunk(text);
    expect(drafts.length).toBe(2);
    expect(drafts[0].text).toContain("如何退款");
    expect(drafts[0].text).toContain("七天内可申请");
  });

  it("识别英文 Q:/A: 标记", () => {
    const text = "Q: What is this?\nA: A test.\nQ: Another?\nA: Yes.";
    const drafts = chunker.chunk(text);
    expect(drafts.length).toBe(2);
  });

  it("退化：无 Q/A 标记时按最低级标题切段（同 general 兜底）", () => {
    const drafts = chunker.chunk("# 一\n没有问答标记的内容");
    expect(drafts.length).toBe(1);
  });
});

describe("分块硬上限（QA 回归：PDF 无空行长文不得产出超长切片）", () => {
  it("GeneralChunker：无空行的超长正文被硬切，所有切片 ≤ 512 token", () => {
    // 模拟 PDF 抽取文本：只有单个换行、无空行 → 旧实现会产出一个 ~3000 token 巨型切片
    const line = "苏州各板块房价与学区资源分布对比分析，二百万预算的购置建议与风险提示。";
    const text = Array.from({ length: 100 }, () => line).join("\n");
    const drafts = new GeneralChunker().chunk(text);

    expect(drafts.length).toBeGreaterThan(1);
    for (const d of drafts) {
      expect(estimateTokens(d.text)).toBeLessThanOrEqual(512);
    }
    // seq 连续
    drafts.forEach((d, i) => expect(d.seq).toBe(i));
  });

  it("QaChunker：超长问答对被硬切为多片，section 保持问句", () => {
    const longAnswer = "这个问题的答案非常长。".repeat(120); // ~1300 token
    const text = `问：二百万预算怎么买？\n答：${longAnswer}`;
    const drafts = new QaChunker().chunk(text);

    expect(drafts.length).toBeGreaterThan(1);
    for (const d of drafts) {
      expect(estimateTokens(d.text)).toBeLessThanOrEqual(512);
      expect(d.section).toBe("二百万预算怎么买？");
    }
  });
});
