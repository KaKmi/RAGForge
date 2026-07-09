import { PDFParse } from "pdf-parse";
import type { DocumentParserPort, ParseResult } from "../../ports/document-parser.port";

/**
 * pdf-parse 依赖为 ^2.4.5（major v2），API 与 @types/pdf-parse（v1 类型，默认导出函数）完全不同：
 * v2 导出 `PDFParse` 类，`new PDFParse({ data }).getText()` 返回 `{ text, pages, total }`。
 *
 * 关键坑：`TextResult.text`（聚合字段）总会在页与页之间/末尾插入 `-- N of N --` 分隔符，
 * 即便某页正文为空（扫描件/图片 PDF）该分隔符依然存在，导致 `.text.trim()` 恒非空、
 * 无法用来判断"解析结果为空"。因此改用 `result.pages` 逐页正文拼接作为真实文本与判空依据。
 */
export class PdfParser implements DocumentParserPort {
  async parse(buffer: Buffer): Promise<ParseResult> {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      const text = result.pages
        .map((page) => page.text)
        .join("\n")
        .trim();
      if (!text) {
        throw new Error("PDF 解析结果为空文本（可能是扫描件/图片 PDF，暂不支持 OCR）");
      }
      return { text };
    } finally {
      await parser.destroy();
    }
  }
}
