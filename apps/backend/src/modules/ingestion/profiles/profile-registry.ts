import type {
  ChunkTemplate,
  DocumentType,
  ProcessingProfileDescriptor,
  ProcessingProfileRef,
} from "@codecrush/contracts";
import { toDescriptor, type ProcessingProfileDefinition } from "./processing-profile";

const DEFAULT_GATE = {
  maxCleanReductionRatio: 0.8,
  maxCanonicalBytes: 50 * 1024 * 1024,
  maxBlocks: 100_000,
  maxChunkTokens: 8192,
};

const ALL_DOCUMENT_TYPES: DocumentType[] = ["pdf", "word", "markdown", "text"];

export const PROCESSING_PROFILES: ProcessingProfileDefinition[] = [
  {
    id: "general-v1",
    version: 1,
    label: "通用文档",
    description: "适合手册、报告、笔记等通用材料",
    summary: "自动解析 · 基础清洗 · 标题结构分块",
    supportedTypes: ALL_DOCUMENT_TYPES,
    parser: { mode: "auto" },
    normalizers: [{ id: "markdown-basic", config: {} }],
    chunker: { id: "general", config: {} },
    qualityGate: DEFAULT_GATE,
  },
  {
    id: "faq-v1",
    version: 1,
    label: "FAQ 问答",
    description: "适合“问：/答：”或 Q:/A: 结构的问答材料",
    summary: "自动解析 · 基础清洗 · 问答对分块",
    supportedTypes: ALL_DOCUMENT_TYPES,
    parser: { mode: "auto" },
    normalizers: [{ id: "markdown-basic", config: {} }],
    chunker: { id: "qa", config: {} },
    qualityGate: DEFAULT_GATE,
  },
  {
    id: "course-wechat-v1",
    version: 1,
    label: "课程/公众号文章",
    description: "适合公众号导出的课程文章：清理导航、推广、图片链接并按课程结构分块",
    summary: "自动解析 · 公众号清洗 · 课程结构分块",
    supportedTypes: ALL_DOCUMENT_TYPES,
    parser: { mode: "auto" },
    normalizers: [{ id: "markdown-basic", config: {} }],
    chunker: { id: "custom", config: {} },
    qualityGate: DEFAULT_GATE,
  },
];

export function chunkTemplateToProfileRef(template: ChunkTemplate): ProcessingProfileRef {
  const profileId =
    template === "qa"
      ? "faq-v1"
      : template === "custom"
        ? "course-wechat-v1"
        : "general-v1";
  return { profileId, profileVersion: 1 };
}

export class ProfileRegistry {
  private readonly byKey = new Map<string, ProcessingProfileDefinition>();

  constructor(
    definitions: ProcessingProfileDefinition[],
    known?: { chunkers: string[]; normalizers: string[] },
  ) {
    for (const definition of definitions) {
      const key = `${definition.id}@${definition.version}`;
      if (this.byKey.has(key)) throw new Error(`重复注册 Profile: ${key}`);
      if (definition.supportedTypes.length === 0) {
        throw new Error(`Profile ${key} supportedTypes 为空`);
      }
      if (known && !known.chunkers.includes(definition.chunker.id)) {
        throw new Error(`Profile ${key} 引用未注册 chunker: ${definition.chunker.id}`);
      }
      if (known) {
        for (const normalizer of definition.normalizers) {
          if (!known.normalizers.includes(normalizer.id)) {
            throw new Error(`Profile ${key} 引用未注册 normalizer: ${normalizer.id}`);
          }
        }
      }
      this.byKey.set(key, definition);
    }
  }

  get(id: string, version: number): ProcessingProfileDefinition | undefined {
    return this.byKey.get(`${id}@${version}`);
  }

  latest(id: string): ProcessingProfileDefinition | undefined {
    let latest: ProcessingProfileDefinition | undefined;
    for (const definition of this.byKey.values()) {
      if (definition.id === id && (!latest || definition.version > latest.version)) {
        latest = definition;
      }
    }
    return latest;
  }

  listForType(documentType?: DocumentType): ProcessingProfileDescriptor[] {
    const latestById = new Map<string, ProcessingProfileDefinition>();
    for (const definition of this.byKey.values()) {
      if (documentType && !definition.supportedTypes.includes(documentType)) continue;
      const current = latestById.get(definition.id);
      if (!current || definition.version > current.version) {
        latestById.set(definition.id, definition);
      }
    }
    return [...latestById.values()].map(toDescriptor);
  }
}
