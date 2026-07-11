export type CanonicalBlockType =
  | "heading"
  | "paragraph"
  | "table"
  | "image"
  | "list"
  | "code";

export interface CanonicalBlock {
  type: CanonicalBlockType;
  markdown: string;
  pageStart: number;
  pageEnd: number;
  assetKey?: string;
}

export interface CanonicalDocument {
  markdown: string;
  blocks: CanonicalBlock[];
  warnings: string[];
  stats: {
    pages: number;
    tables: number;
    images: number;
    ocrPages: number;
  };
}
