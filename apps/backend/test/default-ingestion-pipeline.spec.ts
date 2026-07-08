import { DefaultIngestionPipeline } from "../src/modules/ingestion/default-ingestion-pipeline";
import type { ModelsService } from "../src/modules/models/models.service";
import type { ChunksRepository } from "../src/modules/chunks/chunks.repository";

function make1024Vector(seed: number): number[] {
  return Array.from({ length: 1024 }, (_, i) => (i + seed) / 1024);
}

describe("DefaultIngestionPipeline", () => {
  it("解析->清洗->分块->分批向量化->单次 replaceVersion，chunkCount 与切片数一致", async () => {
    const embedTexts = jest.fn(async (_id: string, texts: string[]) =>
      texts.map((_, i) => make1024Vector(i)),
    );
    const replaceVersion = jest.fn(async () => undefined);
    const pipeline = new DefaultIngestionPipeline(
      { embedTexts } as unknown as ModelsService,
      { replaceVersion } as unknown as ChunksRepository,
      /* batchSize */ 2,
    );

    const result = await pipeline.run({
      documentId: "d1",
      kbId: "kb1",
      docType: "text",
      chunkTemplate: "general",
      embeddingModelId: "m1",
      targetVersion: 1,
      blob: Buffer.from("段落一。\n\n段落二。\n\n段落三。", "utf-8"),
    });

    expect(result.chunkCount).toBeGreaterThan(0);
    expect(replaceVersion).toHaveBeenCalledTimes(1);
    const [docId, kbId, version, drafts] = replaceVersion.mock.calls[0];
    expect(docId).toBe("d1");
    expect(kbId).toBe("kb1");
    expect(version).toBe(1);
    expect(drafts).toHaveLength(result.chunkCount);
    expect(drafts.every((d: { embedding: number[] }) => d.embedding.length === 1024)).toBe(true);
    // 批大小 2：3 个切片应分 2 批调用 embedTexts（2+1）
    expect(embedTexts.mock.calls.length).toBe(Math.ceil(result.chunkCount / 2));
  });

  it("解析结果为空文本时抛出错误（由调用方 Task 16 捕获写入 document.failed）", async () => {
    const pipeline = new DefaultIngestionPipeline(
      { embedTexts: jest.fn() } as unknown as ModelsService,
      { replaceVersion: jest.fn() } as unknown as ChunksRepository,
      10,
    );
    await expect(
      pipeline.run({
        documentId: "d2",
        kbId: "kb1",
        docType: "pdf",
        chunkTemplate: "general",
        embeddingModelId: "m1",
        targetVersion: 1,
        blob: Buffer.from("not a real pdf"),
      }),
    ).rejects.toThrow();
  });
});
