import { Injectable } from "@nestjs/common";
import { PARSER_REGISTRY } from "./adapters/parsers/parser-registry";
import { CHUNKER_REGISTRY } from "./adapters/chunkers/chunker-registry";
import { cleanText } from "./pipeline/clean-text";
import { estimateTokens } from "./pipeline/estimate-tokens";
import { toIngestionError } from "./pipeline/ingestion-error";
import type { ChunkDraft } from "../chunks/schema";
import type { ChunksRepository } from "../chunks/chunks.repository";
import type { ModelsService } from "../models/models.service";
import type {
  IngestionContext,
  IngestionPipelinePort,
  IngestionResult,
} from "./ports/ingestion-pipeline.port";

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

@Injectable()
export class DefaultIngestionPipeline implements IngestionPipelinePort {
  constructor(
    private readonly models: ModelsService,
    private readonly chunksRepo: ChunksRepository,
    private readonly embedBatchSize: number,
  ) {}

  async run(ctx: IngestionContext): Promise<IngestionResult> {
    // 各阶段异常包装为带业务错误码的 IngestionError（`[代码] 中文说明：上游详情`），
    // 由 IngestionService 落进 document.error 供前端直接展示。
    let text: string;
    try {
      const parser = PARSER_REGISTRY[ctx.docType];
      const { text: rawText } = await parser.parse(ctx.blob);
      text = cleanText(rawText);
    } catch (err) {
      throw toIngestionError(err, "PARSE_FAILED");
    }

    const chunker = CHUNKER_REGISTRY[ctx.chunkTemplate];
    const parts = chunker.chunk(text, { filename: ctx.docName, kbName: ctx.kbName });

    const batches = chunkArray(parts, this.embedBatchSize);
    const drafts: ChunkDraft[] = [];
    for (const batch of batches) {
      let vectors: number[][];
      try {
        vectors = await this.models.embedTexts(
          ctx.embeddingModelId,
          batch.map((p) => p.text),
        );
      } catch (err) {
        throw toIngestionError(err, "EMBED_FAILED");
      }
      batch.forEach((p, i) => {
        drafts.push({
          seq: p.seq,
          text: p.text,
          tokenCount: estimateTokens(p.text),
          section: p.section,
          embedding: vectors[i],
        });
      });
    }

    try {
      await this.chunksRepo.replaceVersion(ctx.documentId, ctx.kbId, ctx.targetVersion, drafts);
    } catch (err) {
      throw toIngestionError(err, "STORE_FAILED");
    }
    return { chunkCount: drafts.length, parsedText: text };
  }
}
