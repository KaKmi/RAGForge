import type { DocumentParserPort, ParseResult } from "../../ports/document-parser.port";

// markdown 与 text 共用：两者都是纯文本，格式差异（标题层级）留给 chunker 阶段处理
export class TextParser implements DocumentParserPort {
  async parse(buffer: Buffer): Promise<ParseResult> {
    return { text: buffer.toString("utf-8") };
  }
}
