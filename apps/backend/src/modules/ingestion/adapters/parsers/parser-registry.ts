import type { DocumentType } from "@codecrush/contracts";
import type { DocumentParserPort } from "../../ports/document-parser.port";
import { PdfParser } from "./pdf-parser";
import { WordParser } from "./word-parser";
import { TextParser } from "./text-parser";

const textParser = new TextParser();

// (DocumentType) → parser 表，同 PROBE_BUILDERS 模式：完整性由 parser-registry.spec 断言。
// 新增 DocumentType = 加 parser 文件 + 表项。
export const PARSER_REGISTRY: Record<DocumentType, DocumentParserPort> = {
  pdf: new PdfParser(),
  word: new WordParser(),
  markdown: textParser,
  text: textParser,
};
