import { describe, expect, it } from "vitest";
import {
  ProcessingProfileRefSchema,
  ProcessingProfileDescriptorSchema,
  ProcessingRunSchema,
  ParseDocumentRequestSchema,
  RebuildKnowledgeBaseRequestSchema,
} from "./processing-profiles";
import {
  CreateKnowledgeBaseRequestSchema,
  UpdateKnowledgeBaseRequestSchema,
} from "./knowledge-bases";

describe("processing-profiles contracts", () => {
  it("ProfileRef 要求 id + 正整数版本", () => {
    expect(ProcessingProfileRefSchema.safeParse({ profileId: "general-v1", profileVersion: 1 }).success).toBe(true);
    expect(ProcessingProfileRefSchema.safeParse({ profileId: "", profileVersion: 1 }).success).toBe(false);
    expect(ProcessingProfileRefSchema.safeParse({ profileId: "x", profileVersion: 0 }).success).toBe(false);
  });

  it("Descriptor 携带 label/summary/supportedTypes", () => {
    const r = ProcessingProfileDescriptorSchema.safeParse({
      id: "general-v1",
      version: 1,
      label: "通用文档",
      description: "d",
      supportedTypes: ["pdf", "word", "markdown", "text"],
      summary: "自动解析 · 基础清洗 · 标题结构分块",
    });
    expect(r.success).toBe(true);
  });

  it("Run 状态枚举与可空字段", () => {
    const run = {
      id: "r1",
      documentId: "d1",
      targetVersion: 1,
      profileId: "general-v1",
      profileVersion: 1,
      profileLabel: "通用文档",
      parserEngine: null,
      parserVersion: null,
      status: "queued",
      warnings: [],
      metrics: {},
      error: null,
      startedAt: null,
      endedAt: null,
      createdAt: new Date().toISOString(),
    };
    const r = ProcessingRunSchema.safeParse(run);
    expect(r.success).toBe(true);
    expect(ProcessingRunSchema.safeParse({ ...run, status: "exploded" }).success).toBe(false);
  });

  it("ParseDocumentRequest 允许空对象 / mode:retry / 完整 ref，拒绝半个 ref 与 retry+ref 混用", () => {
    expect(ParseDocumentRequestSchema.safeParse({}).success).toBe(true);
    expect(ParseDocumentRequestSchema.safeParse({ mode: "retry" }).success).toBe(true);
    expect(ParseDocumentRequestSchema.safeParse({ profileId: "general-v1", profileVersion: 1 }).success).toBe(true);
    expect(ParseDocumentRequestSchema.safeParse({ profileId: "general-v1" }).success).toBe(false);
    expect(
      ParseDocumentRequestSchema.safeParse({ mode: "retry", profileId: "general-v1", profileVersion: 1 }).success,
    ).toBe(false);
  });

  it("Rebuild scope 枚举", () => {
    expect(RebuildKnowledgeBaseRequestSchema.safeParse({ scope: "inherited" }).success).toBe(true);
    expect(RebuildKnowledgeBaseRequestSchema.safeParse({ scope: "everything" }).success).toBe(false);
  });
});

describe("knowledge-bases 契约迁移窗口", () => {
  it("create 只带 chunkTemplate（旧前端）合法", () => {
    expect(
      CreateKnowledgeBaseRequestSchema.safeParse({ name: "kb", chunkTemplate: "general", embeddingModelId: "m1" })
        .success,
    ).toBe(true);
  });
  it("create 只带 profile（新前端）合法", () => {
    expect(
      CreateKnowledgeBaseRequestSchema.safeParse({
        name: "kb",
        processingProfileId: "general-v1",
        processingProfileVersion: 1,
        embeddingModelId: "m1",
      }).success,
    ).toBe(true);
  });
  it("create 二者皆缺 → 拒绝", () => {
    expect(CreateKnowledgeBaseRequestSchema.safeParse({ name: "kb", embeddingModelId: "m1" }).success).toBe(false);
  });
  it("create 半个 profile ref → 拒绝", () => {
    expect(
      CreateKnowledgeBaseRequestSchema.safeParse({
        name: "kb",
        processingProfileId: "general-v1",
        embeddingModelId: "m1",
      }).success,
    ).toBe(false);
  });
  it("create 同时带 chunkTemplate 与 profile → 拒绝（与 update 对称，防双写不一致）", () => {
    expect(
      CreateKnowledgeBaseRequestSchema.safeParse({
        name: "kb",
        chunkTemplate: "general",
        processingProfileId: "faq-v1",
        processingProfileVersion: 1,
        embeddingModelId: "m1",
      }).success,
    ).toBe(false);
  });
  it("update 同时带 chunkTemplate 与 profile → 拒绝", () => {
    expect(
      UpdateKnowledgeBaseRequestSchema.safeParse({
        chunkTemplate: "qa",
        processingProfileId: "faq-v1",
        processingProfileVersion: 1,
      }).success,
    ).toBe(false);
  });
  it("update 带完整 profile → 合法", () => {
    expect(
      UpdateKnowledgeBaseRequestSchema.safeParse({ processingProfileId: "faq-v1", processingProfileVersion: 1 })
        .success,
    ).toBe(true);
  });
});
