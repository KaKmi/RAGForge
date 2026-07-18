import { describe, expect, it } from "vitest";
import {
  ApplicationChatResultSchema,
  ApplicationConfigFieldsSchema,
  ApplicationConfigVersionSchema,
  ApplicationDetailSchema,
  ApplicationSchema,
  ApplicationTagNameSchema,
  CreateApplicationRequestSchema,
  MoveApplicationTagRequestSchema,
  PublishProductionRequestSchema,
  PromptUsageEntrySchema,
  ReleaseCheckSchema,
  UpdateApplicationRequestSchema,
} from "./applications";

const node = {
  promptVersionId: "prompt-version",
  modelId: "model",
  freedom: "balance" as const,
  temperature: 0.7,
  topP: 0.9,
};
const config = {
  kbIds: ["kb"],
  nodes: { rewrite: node, intent: node, reply: node, fallback: node },
  retrieval: {
    schemaVersion: 1 as const,
    topK: 20,
    topN: 5,
    hybridEnabled: true,
    vectorWeight: 0.7,
    rerankEnabled: false,
  },
  fallback: { toHuman: true },
};

describe("application contracts", () => {
  it("accepts a complete immutable configuration", () => {
    expect(ApplicationConfigFieldsSchema.parse(config)).toEqual(config);
  });

  it("enforces retrieval cross-field constraints", () => {
    expect(() =>
      ApplicationConfigFieldsSchema.parse({
        ...config,
        retrieval: { ...config.retrieval, topK: 4, topN: 5 },
      }),
    ).toThrow();
    expect(() =>
      ApplicationConfigFieldsSchema.parse({
        ...config,
        retrieval: { ...config.retrieval, rerankEnabled: true },
      }),
    ).toThrow();
    expect(() =>
      ApplicationConfigFieldsSchema.parse({
        ...config,
        retrieval: { ...config.retrieval, topK: 0 },
      }),
    ).toThrow();
    expect(() =>
      ApplicationConfigFieldsSchema.parse({
        ...config,
        retrieval: { ...config.retrieval, vectorWeight: 1.1 },
      }),
    ).toThrow();
    expect(() =>
      ApplicationConfigFieldsSchema.parse({
        ...config,
        retrieval: { ...config.retrieval, schemaVersion: 2 },
      }),
    ).toThrow();
  });

  it("enforces node and complete-config boundaries", () => {
    expect(() =>
      ApplicationConfigFieldsSchema.parse({
        ...config,
        nodes: { ...config.nodes, reply: { ...node, temperature: 2.1 } },
      }),
    ).toThrow();
    expect(() =>
      ApplicationConfigFieldsSchema.parse({
        ...config,
        nodes: { ...config.nodes, reply: { ...node, topP: 1.1 } },
      }),
    ).toThrow();
    expect(() => ApplicationConfigFieldsSchema.parse({ ...config, kbIds: [] })).toThrow();
    expect(() =>
      ApplicationConfigFieldsSchema.parse({
        ...config,
        nodes: { ...config.nodes, summary: node },
      }),
    ).toThrow();
    expect(() =>
      ApplicationConfigFieldsSchema.parse({
        ...config,
        nodes: { ...config.nodes, reply: { ...node, unknown: true } },
      }),
    ).toThrow();
    const { fallback: _missing, ...incompleteNodes } = config.nodes;
    expect(() =>
      ApplicationConfigFieldsSchema.parse({ ...config, nodes: incompleteNodes }),
    ).toThrow();
  });

  it("requires a valid slug and complete v1 config", () => {
    expect(CreateApplicationRequestSchema.parse({ slug: "after-sale", name: "售后", config })).toMatchObject({
      description: "",
    });
    expect(() => CreateApplicationRequestSchema.parse({ slug: "A", name: "售后", config })).toThrow();
    expect(() => CreateApplicationRequestSchema.parse({ slug: "after-sale", name: "售后" })).toThrow();
  });

  it("keeps base updates strict", () => {
    expect(UpdateApplicationRequestSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(UpdateApplicationRequestSchema.parse({ evalGateEnabled: true })).toEqual({
      evalGateEnabled: true,
    });
    expect(() => UpdateApplicationRequestSchema.parse({ slug: "new-slug" })).toThrow();
  });

  it("supports an application with no production pointer", () => {
    const value = {
      id: "application",
      slug: "after-sale",
      name: "售后",
      description: "",
      enabled: true,
      // B1/F5：门禁开关。required（无 .default）——契约层必须钉住必填性，
      // 否则后端漏映射时前端会静默读到 undefined。
      evalGateEnabled: false,
      productionVersion: null,
      productionConfigVersionId: null,
      latestVersion: 1,
      versionCount: 1,
      tags: [],
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z",
      updatedBy: "admin",
      createdBy: "admin",
    };
    expect(ApplicationSchema.parse(value)).toEqual(value);
    expect(() => ApplicationSchema.parse({ ...value, productionVersion: undefined })).toThrow();
    expect(() =>
      ApplicationSchema.parse({ ...value, productionConfigVersionId: undefined }),
    ).toThrow();
    expect(() => ApplicationSchema.parse({ ...value, evalGateEnabled: undefined })).toThrow();

    const version = {
      ...config,
      id: "version",
      applicationId: value.id,
      version: 1,
      configSchemaVersion: 1 as const,
      createdBy: "admin",
      createdAt: value.createdAt,
    };
    expect(ApplicationConfigVersionSchema.parse(version)).toEqual(version);
    expect(ApplicationDetailSchema.parse({ ...value, versions: [version] }).versions).toHaveLength(1);
    expect(() => ApplicationConfigVersionSchema.parse({ ...version, version: 0 })).toThrow();
    expect(() => ApplicationDetailSchema.parse({ ...value, versions: undefined })).toThrow();
  });

  it("restricts prompt usage to the four application nodes", () => {
    const usage = {
      promptVersionId: "pv",
      promptVersion: 1,
      applicationId: "app",
      applicationName: "售后",
      node: "reply" as const,
      configVersion: 1,
    };
    expect(PromptUsageEntrySchema.parse(usage)).toEqual(usage);
    expect(() => PromptUsageEntrySchema.parse({ ...usage, node: "summary" })).toThrow();
  });

  it("defines the M7a chat placeholder", () => {
    expect(
      ApplicationChatResultSchema.parse({
        mode: "unavailable",
        reason: "pending_orchestration",
      }),
    ).toEqual({ mode: "unavailable", reason: "pending_orchestration" });
    expect(() => ApplicationChatResultSchema.parse({ mode: "text", text: "premature" })).toThrow();
    expect(() => ApplicationChatResultSchema.parse({ mode: "unknown" })).toThrow();
  });
});

describe("application version naming tags (M7b)", () => {
  it("normalizes tag name to lowercase", () => {
    expect(ApplicationTagNameSchema.parse("QA2026")).toBe("qa2026");
  });
  it("rejects reserved word production (case-insensitive)", () => {
    expect(() => ApplicationTagNameSchema.parse("production")).toThrow();
    expect(() => ApplicationTagNameSchema.parse("Production")).toThrow();
  });
  it("rejects reserved word v (version-prefix collision)", () => {
    expect(() => ApplicationTagNameSchema.parse("v")).toThrow();
    expect(() => ApplicationTagNameSchema.parse("V")).toThrow();
  });
  it("rejects illegal characters", () => {
    expect(() => ApplicationTagNameSchema.parse("a b")).toThrow();
    expect(() => ApplicationTagNameSchema.parse("标签")).toThrow();
    expect(() => ApplicationTagNameSchema.parse("")).toThrow();
  });
  it("accepts custom anchors including beta", () => {
    expect(ApplicationTagNameSchema.parse("qa20260707")).toBe("qa20260707");
    expect(ApplicationTagNameSchema.parse("beta")).toBe("beta");
    expect(ApplicationTagNameSchema.parse("v2.1_rc-3")).toBe("v2.1_rc-3");
  });
  it("MoveApplicationTagRequest requires name + versionId", () => {
    expect(MoveApplicationTagRequestSchema.parse({ name: "QA", versionId: "v1" })).toEqual({
      name: "qa",
      versionId: "v1",
    });
    expect(() => MoveApplicationTagRequestSchema.parse({ name: "production", versionId: "v1" })).toThrow();
    expect(() => MoveApplicationTagRequestSchema.parse({ name: "qa" })).toThrow();
  });
  it("PublishProductionRequest allows null expected pointer (first publish)", () => {
    expect(
      PublishProductionRequestSchema.parse({
        versionId: "v2",
        releaseCheckId: "rc1",
        expectedProductionVersionId: null,
      }),
    ).toMatchObject({ expectedProductionVersionId: null });
  });
  it("ReleaseCheck accepts a passed check with issues and expiry", () => {
    const check = {
      id: "rc1",
      applicationId: "app1",
      configVersionId: "v2",
      configFingerprint: "abc",
      status: "passed" as const,
      issues: [],
      sampleSummary: {},
      startedAt: "2026-07-12T00:00:00.000Z",
      finishedAt: "2026-07-12T00:00:12.000Z",
      expiresAt: "2026-07-12T00:15:12.000Z",
      createdBy: "admin",
      createdAt: "2026-07-12T00:00:00.000Z",
    };
    expect(ReleaseCheckSchema.parse(check)).toEqual(check);
    expect(() => ReleaseCheckSchema.parse({ ...check, status: "bogus" })).toThrow();
  });
});
