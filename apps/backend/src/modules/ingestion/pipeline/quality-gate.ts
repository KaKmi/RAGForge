import type { QualityGateConfig } from "../profiles/processing-profile";
import { estimateTokens } from "./estimate-tokens";
import { IngestionError } from "./ingestion-error";

export enum GateStage {
  AfterParse = "after-parse",
  AfterNormalize = "after-normalize",
  AfterChunk = "after-chunk",
}

interface DocumentGateInput {
  markdown: string;
  blocks: number;
  rawLength: number;
}

interface ChunkGateInput {
  chunkTexts: string[];
}

export function runQualityGate(
  stage: GateStage,
  gate: QualityGateConfig,
  input: DocumentGateInput | ChunkGateInput,
): void {
  if (stage === GateStage.AfterChunk) {
    const { chunkTexts } = input as ChunkGateInput;
    if (chunkTexts.length === 0) throw new IngestionError("CHUNK_EMPTY");
    if (chunkTexts.some((text) => estimateTokens(text) > gate.maxChunkTokens)) {
      throw new IngestionError("CHUNK_OVERSIZED");
    }
    return;
  }

  const { markdown, blocks, rawLength } = input as DocumentGateInput;
  if (stage === GateStage.AfterParse) {
    if (!markdown.trim()) throw new IngestionError("PARSE_EMPTY");
    return;
  }

  if (
    rawLength > 0 &&
    (rawLength - markdown.length) / rawLength > gate.maxCleanReductionRatio
  ) {
    throw new IngestionError("CLEAN_SUSPICIOUS");
  }
  if (Buffer.byteLength(markdown, "utf8") > gate.maxCanonicalBytes || blocks > gate.maxBlocks) {
    throw new IngestionError("CANONICAL_TOO_LARGE");
  }
}
