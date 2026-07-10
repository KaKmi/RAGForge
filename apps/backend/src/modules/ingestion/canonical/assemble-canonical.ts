import type { ParsedPage } from "../ports/document-parser.port";
import type { CanonicalBlock, CanonicalDocument } from "./canonical-document";

export interface BlockRange {
  start: number;
  end: number;
  pageStart: number;
  pageEnd: number;
}

export interface AssembledCanonical {
  doc: CanonicalDocument;
  blockRanges: BlockRange[];
}

export function computeBlockRanges(blocks: CanonicalBlock[]): {
  markdown: string;
  blockRanges: BlockRange[];
} {
  const blockRanges: BlockRange[] = [];
  let markdown = "";
  for (const block of blocks) {
    if (markdown) markdown += "\n\n";
    const start = markdown.length;
    markdown += block.markdown;
    blockRanges.push({
      start,
      end: markdown.length,
      pageStart: block.pageStart,
      pageEnd: block.pageEnd,
    });
  }
  return { markdown, blockRanges };
}

export function assembleCanonical(pages: ParsedPage[], warnings: string[]): AssembledCanonical {
  const blocks: CanonicalBlock[] = [];
  for (const page of pages) {
    for (const paragraph of page.text.split(/\n\s*\n/)) {
      const markdown = paragraph.trim();
      if (!markdown) continue;
      blocks.push({
        type: "paragraph",
        markdown,
        pageStart: page.page,
        pageEnd: page.page,
      });
    }
  }
  const { markdown, blockRanges } = computeBlockRanges(blocks);
  return {
    doc: {
      markdown,
      blocks,
      warnings,
      stats: { pages: pages.length, tables: 0, images: 0, ocrPages: 0 },
    },
    blockRanges,
  };
}
