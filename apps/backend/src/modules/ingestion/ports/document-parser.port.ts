export interface ParsedPage {
  page: number;
  text: string;
}

export interface ParseOutput {
  engine: string;
  engineVersion: string;
  pages: ParsedPage[];
  warnings: string[];
}

export interface DocumentParserPort {
  parse(buffer: Buffer): Promise<ParseOutput>;
}
