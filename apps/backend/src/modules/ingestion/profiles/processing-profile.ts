import type {
  ChunkTemplate,
  DocumentType,
  ProcessingProfileDescriptor,
  ProcessingProfileRef,
} from "@codecrush/contracts";

export interface QualityGateConfig {
  maxCleanReductionRatio: number;
  maxCanonicalBytes: number;
  maxBlocks: number;
  maxChunkTokens: number;
}

export type ParserMode = "fast" | "auto" | "layout" | "ocr";

export interface ProcessingProfileDefinition {
  id: string;
  version: number;
  label: string;
  description: string;
  summary: string;
  supportedTypes: DocumentType[];
  parser: { mode: ParserMode };
  normalizers: Array<{ id: string; config: Record<string, unknown> }>;
  chunker: { id: ChunkTemplate; config: Record<string, unknown> };
  qualityGate: QualityGateConfig;
}

export type ProcessingProfileSnapshot = ProcessingProfileDefinition;

export function toDescriptor(
  profile: ProcessingProfileDefinition,
): ProcessingProfileDescriptor {
  return {
    id: profile.id,
    version: profile.version,
    label: profile.label,
    description: profile.description,
    supportedTypes: profile.supportedTypes,
    summary: profile.summary,
  };
}

export type { ProcessingProfileRef };
