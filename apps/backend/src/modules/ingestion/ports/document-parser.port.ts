export interface ParseResult {
  text: string;
}

export interface DocumentParserPort {
  parse(buffer: Buffer): Promise<ParseResult>;
}
