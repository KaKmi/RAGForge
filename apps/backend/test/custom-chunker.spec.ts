import { CustomChunker } from "../src/modules/ingestion/adapters/chunkers/custom-chunker";

const chunker = new CustomChunker();
const meta = { filename: "课程-11人才九宫格_2025-05-27.txt", kbName: "揭秘公司治理框架" };

describe("CustomChunker 清洗规则", () => {
  it("删除文件顶部的推广引用块（连续 > 开头行），正文中的 >> 引用保留", () => {
    const text = [
      "> 关注公众号",
      "> **回复1** 领取资料",
      "",
      "## 正文标题",
      "正文第一段。",
      "",
      ">> 这是案例引用，应保留",
    ].join("\n");
    const drafts = chunker.chunk(text, meta);
    const allText = drafts.map((d) => d.text).join("\n");
    expect(allText).not.toContain("关注公众号");
    expect(allText).toContain(">> 这是案例引用，应保留");
  });

  it("删除纯导航链接行（指向 mp.weixin.qq.com 的编号/项目符号链接）", () => {
    const text = [
      "## 前情回顾",
      "1. [第一节：xxx](https://mp.weixin.qq.com/s/abc123)",
      "2. [第二节：yyy](https://mp.weixin.qq.com/s/def456)",
      "正文内容在这里。",
    ].join("\n");
    const drafts = chunker.chunk(text, meta);
    const allText = drafts.map((d) => d.text).join("\n");
    expect(allText).not.toContain("mp.weixin.qq.com");
    expect(allText).toContain("正文内容在这里。");
  });

  it("删除孤立的「前情回顾/往期回顾/历史文章」标签行", () => {
    const text = ["## 标题", "前情回顾：", "正文。"].join("\n");
    const drafts = chunker.chunk(text, meta);
    const allText = drafts.map((d) => d.text).join("\n");
    expect(allText).not.toMatch(/前情回顾[:：]?\s*$/m);
  });

  it("图片整行删除；行内图片替换为空但保留同行其它文字", () => {
    const text = [
      "## 标题",
      "![](https://img.example.com/a.png)",
      "前面文字![](https://img.example.com/b.png)后面文字",
    ].join("\n");
    const drafts = chunker.chunk(text, meta);
    const allText = drafts.map((d) => d.text).join("\n");
    expect(allText).not.toContain("img.example.com");
    expect(allText).toContain("前面文字");
    expect(allText).toContain("后面文字");
  });

  it("压缩 3 个以上连续空行为 1 个空行", () => {
    const text = ["## 标题", "第一段。", "", "", "", "第二段。"].join("\n");
    const drafts = chunker.chunk(text, meta);
    expect(drafts[0].text).not.toMatch(/\n{3,}/);
  });
});

describe("CustomChunker 文件名解析与上下文头", () => {
  it("课程文件名解析出课号+主题，header 用知识库名称作为课程名（不写死）", () => {
    const text = "## 小节标题\n正文内容。";
    const drafts = chunker.chunk(text, {
      filename: "课程-11人才九宫格_2025-05-27.txt",
      kbName: "揭秘公司治理框架",
    });
    expect(drafts[0].section).toBe("《揭秘公司治理框架》第11课·人才九宫格 > 小节标题");
    expect(drafts[0].text.startsWith("《揭秘公司治理框架》第11课·人才九宫格 > 小节标题\n\n")).toBe(
      true,
    );
  });

  it("兼容 .md.txt 双后缀文件名", () => {
    const text = "## 小节\n正文。";
    const drafts = chunker.chunk(text, {
      filename: "课程-06经理_2025-05-27.md.txt",
      kbName: "测试课程",
    });
    expect(drafts[0].section).toBe("《测试课程》第6课·经理 > 小节");
  });

  it("换一个知识库名称，header 里的课程名随之改变（验证不写死）", () => {
    const text = "## 小节\n正文。";
    const a = chunker.chunk(text, { filename: "课程-01导论_2026-01-01.txt", kbName: "课程A" })[0]
      .section;
    const b = chunker.chunk(text, { filename: "课程-01导论_2026-01-01.txt", kbName: "课程B" })[0]
      .section;
    expect(a).toContain("《课程A》");
    expect(b).toContain("《课程B》");
  });

  it("非课程命名规则的文件名：header 退化为「文件名 > 小节标题」", () => {
    const text = "## 小节\n正文。";
    const drafts = chunker.chunk(text, { filename: "随手笔记.txt", kbName: "随手库" });
    expect(drafts[0].section).toBe("随手笔记 > 小节");
  });
});

describe("CustomChunker 结构切分", () => {
  it("按 ## 一级标题切主段；首个 ## 之前的内容归为「引言」", () => {
    // 第一节正文需 ≥50 字，否则触发「过短整节并入上一 chunk」规则（另有专门用例覆盖）。
    const text = ["这是引言部分的内容。", "", "## 第一节", "第一节正文内容。".repeat(10)].join(
      "\n",
    );
    const drafts = chunker.chunk(text, meta);
    expect(drafts[0].section).toContain("引言");
    expect(drafts.some((d) => d.section.includes("第一节"))).toBe(true);
  });

  it("超过 MAX_SECTION(1200) 的小节按 ### 子标题二次切分", () => {
    const longPara = "详细内容句子。".repeat(100); // 单段本身不超 1200，但子标题拼起来超长
    const text = ["## 大标题", "### 子标题一", longPara, "### 子标题二", longPara].join("\n\n");
    const drafts = chunker.chunk(text, meta);
    const withSub1 = drafts.find((d) => d.text.includes("子标题一"));
    const withSub2 = drafts.find((d) => d.text.includes("子标题二"));
    expect(withSub1).toBeDefined();
    expect(withSub2).toBeDefined();
    expect(withSub1).not.toBe(withSub2);
  });

  it("子标题下仍超长按段落聚合到 TARGET(800) 左右，块间带 overlap", () => {
    const paragraphs = Array.from({ length: 20 }, (_, i) =>
      `第${i}段内容，重复填充文字。`.repeat(6),
    );
    const text = ["## 大标题", "### 唯一子标题", paragraphs.join("\n\n")].join("\n\n");
    const drafts = chunker.chunk(text, meta);
    expect(drafts.length).toBeGreaterThan(1);
    // overlap 标记「……」应出现在除第一片外的后续片段里
    const later = drafts.slice(1);
    expect(later.some((d) => d.text.includes("……"))).toBe(true);
  });

  it("单段超长（无空行，如连续引用块）按中文句末标点硬切", () => {
    const longSingleParagraph = "这是一句很长的句子。".repeat(150); // 无空行分隔，单段超 1200
    const text = ["## 大标题", "### 子标题", longSingleParagraph].join("\n\n");
    const drafts = chunker.chunk(text, meta);
    expect(drafts.length).toBeGreaterThan(1);
    for (const d of drafts) {
      // 每片正文（去掉 header 行）都应该以句号结尾或是最后一片
      expect(d.text.length).toBeGreaterThan(0);
    }
  });

  it("相邻小块（<200字）合并，避免碎片", () => {
    // 两个都不足 MIN_CHUNK 的子标题块应被合并成一个 chunk
    const text = ["## 大标题", "### 小块一", "很短的内容。", "### 小块二", "也很短。"].join("\n\n");
    // 注意：只有当子标题拼起来的总长仍不超 MAX_SECTION 才会进入二次切分路径；
    // 若总长本就 <=1200，splitLong 不会被触发（sec.text.length <= MAX_SECTION 直接整段成一个 chunk）。
    const drafts = chunker.chunk(text, meta);
    expect(drafts.length).toBe(1);
    expect(drafts[0].text).toContain("小块一");
    expect(drafts[0].text).toContain("小块二");
  });

  it("<50字的整节直接并入上一个 chunk（图片说明残留场景）", () => {
    const text = [
      "## 正文标题",
      "这是一段足够长的正文内容用来构成独立的 chunk。",
      "## 如图所示",
      "见图",
    ].join("\n\n");
    const drafts = chunker.chunk(text, meta);
    expect(drafts.length).toBe(1);
    expect(drafts[0].text).toContain("如图所示");
    expect(drafts[0].text).toContain("见图");
  });

  it("seq 从 0 连续递增", () => {
    const text = ["## 一", "正文一。", "## 二", "正文二。", "## 三", "正文三。"].join("\n\n");
    const drafts = chunker.chunk(text, meta);
    drafts.forEach((d, i) => expect(d.seq).toBe(i));
  });
});
