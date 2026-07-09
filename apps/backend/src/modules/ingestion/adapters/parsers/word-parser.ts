import mammoth from "mammoth";
import type { DocumentParserPort, ParseResult } from "../../ports/document-parser.port";

export class WordParser implements DocumentParserPort {
  async parse(buffer: Buffer): Promise<ParseResult> {
    const result = await mammoth.extractRawText({ buffer });
    const text = result.value.trim();
    if (!text) {
      throw new Error("Word 文档解析结果为空文本");
    }
    return { text };
  }
}
