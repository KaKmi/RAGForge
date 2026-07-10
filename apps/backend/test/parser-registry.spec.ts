import { DocumentTypeSchema } from "@codecrush/contracts";
import { PDFParse } from "pdf-parse";
import { PARSER_REGISTRY } from "../src/modules/ingestion/adapters/parsers/parser-registry";

describe("PARSER_REGISTRY 完整性", () => {
  it("四种 DocumentType 都有 parser", () => {
    for (const type of DocumentTypeSchema.options) {
      expect(PARSER_REGISTRY[type]).toBeDefined();
    }
    expect(Object.keys(PARSER_REGISTRY)).toHaveLength(4);
  });
});

describe("text/markdown parser", () => {
  it("原样返回 UTF-8 文本（单页包装）", async () => {
    const r = await PARSER_REGISTRY.text.parse(Buffer.from("hello world", "utf-8"));
    expect(r.pages).toEqual([{ page: 1, text: "hello world" }]);
  });
  it("markdown 与 text 共用同一 parser（原样文本，清洗阶段统一处理格式）", async () => {
    const r = await PARSER_REGISTRY.markdown.parse(Buffer.from("# 标题\n正文", "utf-8"));
    expect(r.pages[0].text).toContain("# 标题");
  });
});

describe("pdf parser", () => {
  it("空/非法 PDF buffer 应抛出可读错误而非静默返回空串", async () => {
    await expect(PARSER_REGISTRY.pdf.parse(Buffer.from("not a pdf"))).rejects.toThrow();
  });

  // M4.1：parser 只负责逐页取文本，不再对"逐页正文为空"抛错——空文本判定上移到质量门
  // （GateStage.AfterParse → PARSE_EMPTY，见 quality-gate.spec）。pdf-parse v2 的 TextResult.text
  // 聚合字段会在页间/末尾插入 `-- N of N --` 分隔符，即便某页正文为空该分隔符依然存在；因此 parser
  // 用 result.pages 逐页正文作为真实文本，扫描件/图片 PDF 会得到 text 为空的页而非被分隔符污染。
  it("结构合法但逐页正文为空（扫描件/图片 PDF）→ 返回空文本页，不抛错（判空交质量门）", async () => {
    const getTextSpy = jest.spyOn(PDFParse.prototype, "getText").mockResolvedValue({
      pages: [{ text: "", num: 1 }],
      text: "\n\n-- 1 of 1 --\n\n",
      total: 1,
    } as Awaited<ReturnType<PDFParse["getText"]>>);
    const destroySpy = jest.spyOn(PDFParse.prototype, "destroy").mockResolvedValue(undefined);
    try {
      const r = await PARSER_REGISTRY.pdf.parse(Buffer.from("dummy"));
      expect(r.pages).toEqual([{ page: 1, text: "" }]);
    } finally {
      getTextSpy.mockRestore();
      destroySpy.mockRestore();
    }
  });
});

describe("word parser", () => {
  it("空/非法 docx buffer 应抛出可读错误", async () => {
    await expect(PARSER_REGISTRY.word.parse(Buffer.from("not a docx"))).rejects.toThrow();
  });
});
