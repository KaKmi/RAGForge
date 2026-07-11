import type { DocumentType } from "@codecrush/contracts";
import { DefaultIngestionPipeline } from "../src/modules/ingestion/default-ingestion-pipeline";
import type { ModelsService } from "../src/modules/models/models.service";
import type { ChunksRepository } from "../src/modules/chunks/chunks.repository";
import { PARSER_REGISTRY } from "../src/modules/ingestion/adapters/parsers/parser-registry";
import { CHUNKER_REGISTRY } from "../src/modules/ingestion/adapters/chunkers/chunker-registry";
import { NORMALIZER_REGISTRY } from "../src/modules/ingestion/adapters/normalizers/normalizer-registry";
import type { ChunkerPort } from "../src/modules/ingestion/ports/chunker.port";
import type { DocumentNormalizerPort } from "../src/modules/ingestion/ports/document-normalizer.port";
import type { ProcessingProfileSnapshot } from "../src/modules/ingestion/profiles/processing-profile";

function make1024Vector(seed: number): number[] {
  return Array.from({ length: 1024 }, (_, i) => (i + seed) / 1024);
}

// 通用快照：markdown-basic 清洗 + general 分块 + 默认质量门（与 general-v1 一致）。
const GENERAL_SNAPSHOT: ProcessingProfileSnapshot = {
  id: "general-v1",
  version: 1,
  label: "通用文档",
  description: "",
  summary: "",
  supportedTypes: ["pdf", "word", "markdown", "text"],
  parser: { mode: "fast" },
  normalizers: [{ id: "markdown-basic", config: {} }],
  chunker: { id: "general", config: {} },
  qualityGate: {
    maxCleanReductionRatio: 0.8,
    maxCanonicalBytes: 50 * 1024 * 1024,
    maxBlocks: 100_000,
    maxChunkTokens: 8192,
  },
};

function makePipeline(
  models: Partial<ModelsService>,
  chunksRepo: Partial<ChunksRepository>,
  batchSize: number,
): DefaultIngestionPipeline {
  return new DefaultIngestionPipeline(
    models as ModelsService,
    chunksRepo as ChunksRepository,
    batchSize,
    PARSER_REGISTRY as Record<DocumentType, (typeof PARSER_REGISTRY)[DocumentType]>,
    CHUNKER_REGISTRY as unknown as Record<string, ChunkerPort>,
    NORMALIZER_REGISTRY as Record<string, DocumentNormalizerPort>,
  );
}

function ctx(overrides: Partial<Parameters<DefaultIngestionPipeline["run"]>[0]>) {
  return {
    documentId: "d1",
    kbId: "kb1",
    docType: "text" as DocumentType,
    snapshot: GENERAL_SNAPSHOT,
    embeddingModelId: "m1",
    targetVersion: 1,
    docName: "a.txt",
    kbName: "测试库",
    blob: Buffer.from("正文内容", "utf-8"),
    ...overrides,
  };
}

describe("DefaultIngestionPipeline", () => {
  it("解析->清洗->分块->分批向量化->单次 replaceVersion，chunkCount 与切片数一致", async () => {
    const embedTexts = jest.fn(async (_id: string, texts: string[]) =>
      texts.map((_, i) => make1024Vector(i)),
    );
    const replaceVersion = jest.fn(async () => undefined);
    const pipeline = makePipeline({ embedTexts }, { replaceVersion }, /* batchSize */ 2);

    const result = await pipeline.run(
      ctx({ blob: Buffer.from("段落一。\n\n段落二。\n\n段落三。", "utf-8") }),
    );

    expect(result.chunkCount).toBeGreaterThan(0);
    expect(result.markdown).toBe(result.parsedText);
    expect(replaceVersion).toHaveBeenCalledTimes(1);
    const [docId, kbId, version, drafts] = replaceVersion.mock.calls[0];
    expect(docId).toBe("d1");
    expect(kbId).toBe("kb1");
    expect(version).toBe(1);
    expect(drafts).toHaveLength(result.chunkCount);
    expect(drafts.every((d: { embedding: number[] }) => d.embedding.length === 1024)).toBe(true);
    // 批大小 2：N 个切片应分 ceil(N/2) 批调用 embedTexts
    expect(embedTexts.mock.calls.length).toBe(Math.ceil(result.chunkCount / 2));
  });

  it("解析结果为空文本（质量门 PARSE_EMPTY）→ 抛错，不触碰切片存储", async () => {
    const replaceVersion = jest.fn();
    const pipeline = makePipeline({ embedTexts: jest.fn() }, { replaceVersion }, 10);
    await expect(pipeline.run(ctx({ blob: Buffer.from("   \n\n  ", "utf-8") }))).rejects.toThrow(
      /^\[PARSE_EMPTY\]/,
    );
    expect(replaceVersion).not.toHaveBeenCalled();
  });
});

describe("DefaultIngestionPipeline 业务错误码（QA 回归）", () => {
  it("向量化上游报错 → [EMBED_FAILED] 前缀 + 上游详情保留，不落库", async () => {
    const models = {
      embedTexts: jest
        .fn()
        .mockRejectedValue(
          new Error(
            "HTTP 400: <400> InternalError.Algo.InvalidParameter: Range of input length should be [1, 8192]",
          ),
        ),
    };
    const replaceVersion = jest.fn();
    const pipeline = makePipeline(models, { replaceVersion }, 10);
    await expect(pipeline.run(ctx({}))).rejects.toThrow(/^\[EMBED_FAILED\] 向量化失败：HTTP 400/);
    expect(replaceVersion).not.toHaveBeenCalled();
  });

  it("解析失败（损坏 PDF）→ [PARSE_FAILED] 前缀", async () => {
    const pipeline = makePipeline({ embedTexts: jest.fn() }, { replaceVersion: jest.fn() }, 10);
    await expect(
      pipeline.run(ctx({ docType: "pdf", docName: "d.pdf", blob: Buffer.from("not a pdf") })),
    ).rejects.toThrow(/^\[PARSE_FAILED\] 文档解析失败：/);
  });
});
