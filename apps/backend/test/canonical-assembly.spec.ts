import { assembleCanonical } from "../src/modules/ingestion/canonical/assemble-canonical";
import { mapChunkPages } from "../src/modules/ingestion/pipeline/page-mapper";

describe("assembleCanonical", () => {
  it("逐页按空行生成 paragraph blocks 并保留页码与偏移", () => {
    const { doc, blockRanges } = assembleCanonical(
      [
        { page: 1, text: "第一段\n\n第二段" },
        { page: 2, text: "第三段" },
      ],
      [],
    );
    expect(doc.blocks).toHaveLength(3);
    expect(doc.blocks[0]).toMatchObject({
      type: "paragraph",
      markdown: "第一段",
      pageStart: 1,
      pageEnd: 1,
    });
    expect(doc.blocks[2]).toMatchObject({ markdown: "第三段", pageStart: 2, pageEnd: 2 });
    expect(doc.markdown).toBe("第一段\n\n第二段\n\n第三段");
    expect(doc.stats.pages).toBe(2);
    expect(doc.markdown.slice(blockRanges[2].start, blockRanges[2].end)).toBe("第三段");
  });

  it("跳过空白页，全空输入产生空 Canonical Document", () => {
    const { doc } = assembleCanonical([{ page: 1, text: "  \n " }], []);
    expect(doc.blocks).toHaveLength(0);
    expect(doc.markdown).toBe("");
  });
});

describe("mapChunkPages", () => {
  const { doc, blockRanges } = assembleCanonical(
    [
      { page: 1, text: "苹果的历史很长。\n\n香蕉富含钾。" },
      { page: 2, text: "橙子来自中国。" },
    ],
    [],
  );

  it("定位单页和跨页 chunk", () => {
    expect(mapChunkPages(doc.markdown, blockRanges, ["香蕉富含钾。"]))
      .toEqual([{ pageStart: 1, pageEnd: 1 }]);
    expect(
      mapChunkPages(doc.markdown, blockRanges, ["香蕉富含钾。\n\n橙子来自中国。"]),
    ).toEqual([{ pageStart: 1, pageEnd: 2 }]);
  });

  it("跳过 CustomChunker 合成头后按正文锚点定位", () => {
    expect(
      mapChunkPages(doc.markdown, blockRanges, [
        "《示例课程》第1课·主题 > 小节\n\n苹果的历史很长。",
      ]),
    ).toEqual([{ pageStart: 1, pageEnd: 1 }]);
    expect(
      mapChunkPages(doc.markdown, blockRanges, ["主题 > 小节\n\n橙子来自中国。"]),
    ).toEqual([{ pageStart: 2, pageEnd: 2 }]);
  });

  it("无法定位时返回 null 页码而非抛错", () => {
    expect(mapChunkPages(doc.markdown, blockRanges, ["火星土豆种植指南"])).toEqual([
      { pageStart: null, pageEnd: null },
    ]);
  });
});
