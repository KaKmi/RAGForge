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
  it("原样返回 UTF-8 文本", async () => {
    const r = await PARSER_REGISTRY.text.parse(Buffer.from("hello world", "utf-8"));
    expect(r.text).toBe("hello world");
  });
  it("markdown 与 text 共用同一 parser（原样文本，清洗阶段统一处理格式）", async () => {
    const r = await PARSER_REGISTRY.markdown.parse(Buffer.from("# 标题\n正文", "utf-8"));
    expect(r.text).toContain("# 标题");
  });
});

describe("pdf parser", () => {
  it("空/非法 PDF buffer 应抛出可读错误而非静默返回空串", async () => {
    await expect(PARSER_REGISTRY.pdf.parse(Buffer.from("not a pdf"))).rejects.toThrow();
  });

  // pdf-parse v2 的 TextResult.text 聚合字段会在页与页之间/末尾插入 `-- N of N --` 分隔符，
  // 即便某页正文为空（扫描件/图片 PDF）该分隔符依然存在，若直接对 .text 判空会被掩盖、
  // 误判为解析成功。用 spyOn 模拟"结构合法但逐页正文为空"的真实响应形状，验证 parser
  // 是按 result.pages 逐页文本判空，而不是被分隔符污染的聚合字段误导。
  it("结构合法但逐页正文为空（扫描件/图片 PDF）应抛出可读错误，不被分隔符文本掩盖", async () => {
    const getTextSpy = jest.spyOn(PDFParse.prototype, "getText").mockResolvedValue({
      pages: [{ text: "", num: 1 }],
      text: "\n\n-- 1 of 1 --\n\n",
      total: 1,
    } as Awaited<ReturnType<PDFParse["getText"]>>);
    const destroySpy = jest.spyOn(PDFParse.prototype, "destroy").mockResolvedValue(undefined);
    try {
      await expect(PARSER_REGISTRY.pdf.parse(Buffer.from("dummy"))).rejects.toThrow(/扫描件/);
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
