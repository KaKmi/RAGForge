import type { BlockRange } from "../canonical/assemble-canonical";

export interface ChunkPageRange {
  pageStart: number | null;
  pageEnd: number | null;
}

function anchorsOf(chunkText: string): string[] {
  const text = chunkText.trim();
  const anchors = [text.slice(0, 64)];
  const bodyStart = text.indexOf("\n\n");
  if (bodyStart !== -1) {
    const body = text.slice(bodyStart + 2).trim().slice(0, 64);
    if (body) anchors.push(body);
  }
  return anchors;
}

function pageAt(ranges: BlockRange[], offset: number): { start: number; end: number } | null {
  for (const range of ranges) {
    if (offset >= range.start && offset < range.end) {
      return { start: range.pageStart, end: range.pageEnd };
    }
  }
  return null;
}

export function mapChunkPages(
  markdown: string,
  blockRanges: BlockRange[],
  chunkTexts: string[],
): ChunkPageRange[] {
  let cursor = 0;
  return chunkTexts.map((chunkText) => {
    let index = -1;
    let anchorLength = 0;
    for (const anchor of anchorsOf(chunkText)) {
      if (!anchor) continue;
      index = markdown.indexOf(anchor, cursor);
      if (index === -1) index = markdown.indexOf(anchor);
      if (index !== -1) {
        anchorLength = anchor.length;
        break;
      }
    }
    if (index === -1) return { pageStart: null, pageEnd: null };

    cursor = index + anchorLength;
    const exactIndex = markdown.indexOf(chunkText.trim(), index);
    const endOffset =
      exactIndex === index ? index + chunkText.trim().length - 1 : index + anchorLength - 1;
    const startPage = pageAt(blockRanges, index);
    const endPage = pageAt(blockRanges, Math.max(endOffset, index)) ?? startPage;
    if (!startPage) return { pageStart: null, pageEnd: null };
    return {
      pageStart: startPage.start,
      pageEnd: Math.max(startPage.end, endPage?.end ?? startPage.end),
    };
  });
}
