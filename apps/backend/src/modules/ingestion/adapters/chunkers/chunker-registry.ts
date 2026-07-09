import type { ChunkTemplate } from "@codecrush/contracts";
import type { ChunkerPort } from "../../ports/chunker.port";
import { GeneralChunker } from "./general-chunker";
import { QaChunker } from "./qa-chunker";
import { CustomChunker } from "./custom-chunker";

export const CHUNKER_REGISTRY: Record<ChunkTemplate, ChunkerPort> = {
  general: new GeneralChunker(),
  qa: new QaChunker(),
  custom: new CustomChunker(),
};
