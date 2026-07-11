import { Injectable } from "@nestjs/common";
import type { DocumentType } from "@codecrush/contracts";
import type { ChunkDraft } from "../chunks/schema";
import type { ChunksRepository } from "../chunks/chunks.repository";
import type { ModelsService } from "../models/models.service";
import { computeBlockRanges, assembleCanonical } from "./canonical/assemble-canonical";
import type { ChunkerPort } from "./ports/chunker.port";
import type { DocumentNormalizerPort } from "./ports/document-normalizer.port";
import type { DocumentParserPort } from "./ports/document-parser.port";
import type {
  IngestionContext,
  IngestionPipelinePort,
  IngestionResult,
} from "./ports/ingestion-pipeline.port";
import { estimateTokens } from "./pipeline/estimate-tokens";
import { IngestionError, toIngestionError } from "./pipeline/ingestion-error";
import { mapChunkPages } from "./pipeline/page-mapper";
import { GateStage, runQualityGate } from "./pipeline/quality-gate";

function chunkArray<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

@Injectable()
export class DefaultIngestionPipeline implements IngestionPipelinePort {
  constructor(
    private readonly models: ModelsService,
    private readonly chunksRepo: ChunksRepository,
    private readonly embedBatchSize: number,
    private readonly parsers: Record<DocumentType, DocumentParserPort>,
    private readonly chunkers: Record<string, ChunkerPort>,
    private readonly normalizers: Record<string, DocumentNormalizerPort>,
  ) {}

  async run(ctx: IngestionContext): Promise<IngestionResult> {
    const metrics: Record<string, number> = {};

    const parseStarted = Date.now();
    let parsed: Awaited<ReturnType<DocumentParserPort["parse"]>>;
    try {
      parsed = await this.parsers[ctx.docType].parse(ctx.blob);
    } catch (error) {
      throw toIngestionError(error, "PARSE_FAILED");
    }
    metrics.parseMs = Date.now() - parseStarted;

    let { doc: canonical } = assembleCanonical(parsed.pages, parsed.warnings);
    const rawLength = canonical.markdown.length;
    runQualityGate(GateStage.AfterParse, ctx.snapshot.qualityGate, {
      markdown: canonical.markdown,
      blocks: canonical.blocks.length,
      rawLength,
    });

    const normalizeStarted = Date.now();
    for (const step of ctx.snapshot.normalizers) {
      const normalizer = this.normalizers[step.id];
      if (!normalizer) {
        throw new IngestionError("PROFILE_INVALID", `normalizer ${step.id} 未注册`);
      }
      try {
        canonical = normalizer.normalize(canonical, step.config);
      } catch (error) {
        throw toIngestionError(error, "PROFILE_INVALID");
      }
    }
    const rebuilt = computeBlockRanges(canonical.blocks);
    canonical = { ...canonical, markdown: rebuilt.markdown };
    metrics.normalizeMs = Date.now() - normalizeStarted;
    runQualityGate(GateStage.AfterNormalize, ctx.snapshot.qualityGate, {
      markdown: canonical.markdown,
      blocks: canonical.blocks.length,
      rawLength,
    });

    const chunker = this.chunkers[ctx.snapshot.chunker.id];
    if (!chunker) {
      throw new IngestionError("PROFILE_INVALID", `chunker ${ctx.snapshot.chunker.id} 未注册`);
    }
    const chunkStarted = Date.now();
    const parts = chunker.chunk(canonical.markdown, {
      filename: ctx.docName,
      kbName: ctx.kbName,
    });
    runQualityGate(GateStage.AfterChunk, ctx.snapshot.qualityGate, {
      chunkTexts: parts.map((part) => part.text),
    });
    const pageRanges = mapChunkPages(
      canonical.markdown,
      rebuilt.blockRanges,
      parts.map((part) => part.text),
    );
    metrics.chunkMs = Date.now() - chunkStarted;

    const embedStarted = Date.now();
    const drafts: ChunkDraft[] = [];
    for (const batch of chunkArray(parts, this.embedBatchSize)) {
      let vectors: number[][];
      try {
        vectors = await this.models.embedTexts(
          ctx.embeddingModelId,
          batch.map((part) => part.text),
        );
      } catch (error) {
        throw toIngestionError(error, "EMBED_FAILED");
      }
      for (const [index, part] of batch.entries()) {
        const globalIndex = drafts.length;
        const pageRange = pageRanges[globalIndex];
        drafts.push({
          seq: part.seq,
          text: part.text,
          tokenCount: estimateTokens(part.text),
          section: part.section,
          embedding: vectors[index],
          processingRunId: ctx.processingRunId ?? null,
          contentType: "paragraph",
          pageStart: pageRange?.pageStart ?? null,
          pageEnd: pageRange?.pageEnd ?? null,
          assetKey: null,
        });
      }
    }
    metrics.embedMs = Date.now() - embedStarted;

    try {
      await this.chunksRepo.replaceVersion(ctx.documentId, ctx.kbId, ctx.targetVersion, drafts);
    } catch (error) {
      throw toIngestionError(error, "STORE_FAILED");
    }

    Object.assign(metrics, {
      pages: canonical.stats.pages,
      blocks: canonical.blocks.length,
      chunks: drafts.length,
      tables: canonical.stats.tables,
      images: canonical.stats.images,
      ocrPages: canonical.stats.ocrPages,
    });
    return {
      chunkCount: drafts.length,
      markdown: canonical.markdown,
      parsedText: canonical.markdown,
      canonical,
      parserEngine: parsed.engine,
      parserVersion: parsed.engineVersion,
      warnings: canonical.warnings,
      metrics,
    };
  }
}
