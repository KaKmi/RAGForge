import mammoth from "mammoth";
import type { DocumentParserPort, ParseOutput } from "../../ports/document-parser.port";

const MAMMOTH_VERSION = "1.12.0";

export class WordParser implements DocumentParserPort {
  async parse(buffer: Buffer): Promise<ParseOutput> {
    const result = await mammoth.extractRawText({ buffer });
    return {
      engine: "mammoth",
      engineVersion: MAMMOTH_VERSION,
      pages: [{ page: 1, text: result.value }],
      warnings: result.messages.map((message) => message.message),
    };
  }
}
