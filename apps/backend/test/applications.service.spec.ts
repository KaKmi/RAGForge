import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { ApplicationsService } from "../src/modules/applications/applications.service";

const now = new Date("2026-07-11T00:00:00.000Z");
const config = {
  kbIds: ["kb"],
  nodes: Object.fromEntries(
    ["rewrite", "intent", "reply", "fallback"].map((node) => [
      node,
      {
        promptVersionId: `p-${node}`,
        modelId: "llm",
        freedom: "balance",
        temperature: 0.7,
        topP: 0.9,
      },
    ]),
  ),
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
const version = {
  id: "v1",
  applicationId: "a1",
  version: 1,
  configSchemaVersion: 1,
  promptRewriteVersionId: "p-rewrite",
  promptIntentVersionId: "p-intent",
  promptReplyVersionId: "p-reply",
  promptFallbackVersionId: "p-fallback",
  rewriteModelId: "llm",
  intentModelId: "llm",
  replyModelId: "llm",
  fallbackModelId: "llm",
  rerankModelId: null,
  nodeParams: {
    rewrite: { freedom: "balance" as const, temperature: 0.7, topP: 0.9 },
    intent: { freedom: "balance" as const, temperature: 0.7, topP: 0.9 },
    reply: { freedom: "balance" as const, temperature: 0.7, topP: 0.9 },
    fallback: { freedom: "balance" as const, temperature: 0.7, topP: 0.9 },
  },
  retrievalParams: config.retrieval,
  fallbackParams: config.fallback,
  note: null,
  createdBy: "u",
  createdAt: now,
};
function service(overrides: Record<string, unknown> = {}) {
  const repo = {
    findApplicationById: jest.fn(async () => ({
      id: "a1",
      slug: "after-sale",
      name: "售后",
      description: "",
      enabled: true,
      productionConfigVersionId: null,
      productionVersion: null,
      latestVersion: 1,
      versionCount: 1,
      createdBy: "u",
      updatedBy: "u",
      createdAt: now,
      updatedAt: now,
    })),
    findBySlug: jest.fn(async () => undefined),
    findByName: jest.fn(async () => undefined),
    findVersions: jest.fn(async () => [version]),
    findVersionById: jest.fn(async () => version),
    findVersionKbIds: jest.fn(async () => ["kb"]),
    findKbIdsByVersionIds: jest.fn(async () => new Map([["v1", ["kb"]]])),
    createApplicationWithV1: jest.fn(async () => ({ application: { id: "a1" }, version })),
    insertVersion: jest.fn(async () => version),
    findPromptUsage: jest.fn(async () => []),
    ...overrides,
  };
  const kbs = { findByIds: jest.fn(async () => [{ id: "kb", embeddingModelId: "embed" }]) };
  const models = { get: jest.fn(async () => ({ type: "llm", enabled: true })) };
  const prompts = {
    getVersionMeta: jest.fn(async (id: string) => ({ promptId: "p", node: id.slice(2) })),
    listVersions: jest.fn(async () => []),
  };
  return {
    app: new ApplicationsService(repo as never, kbs as never, models as never, prompts as never),
    repo,
    kbs,
    models,
    prompts,
  };
}
describe("ApplicationsService", () => {
  it("creates an unpublished v1 with immutable config", async () => {
    const { app, repo } = service();
    const result = await app.create(
      { slug: "after-sale", name: "售后", description: "", config },
      "u",
    );
    expect(repo.createApplicationWithV1).toHaveBeenCalledWith(
      expect.objectContaining({ productionConfigVersionId: null }),
      expect.objectContaining({ version: 1 }),
      ["kb"],
    );
    expect(result.versions[0].version).toBe(1);
  });
  it("rejects a prompt assigned to the wrong node", async () => {
    const { app, prompts } = service();
    prompts.getVersionMeta.mockResolvedValue({ promptId: "p", node: "reply" });
    await expect(
      app.create({ slug: "after-sale", name: "售后", description: "", config }, "u"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it("rejects a version owned by a different application", async () => {
    const { app, repo } = service({
      findVersionById: jest.fn(async () => ({ ...version, applicationId: "other" })),
    });
    await expect(app.tryVersionChat("a1", "v1")).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.findVersionById).toHaveBeenCalled();
  });
  it("returns the stable M7a chat placeholder", async () => {
    const { app } = service();
    await expect(app.tryVersionChat("a1", "v1")).resolves.toEqual({
      mode: "unavailable",
      reason: "pending_orchestration",
    });
  });
  it("normalizes top-level and wrapped unique violations to 409", async () => {
    const topLevel = Object.assign(new Error("duplicate"), { code: "23505" });
    const { app } = service({
      createApplicationWithV1: jest.fn(async () => {
        throw topLevel;
      }),
    });
    await expect(
      app.create({ slug: "after-sale", name: "售后", description: "", config }, "u"),
    ).rejects.toBeInstanceOf(ConflictException);
    const wrapped = Object.assign(new Error("wrapped"), { cause: { code: "23505" } });
    const second = service({
      createApplicationWithV1: jest.fn(async () => {
        throw wrapped;
      }),
    });
    await expect(
      second.app.create({ slug: "after-sale", name: "售后", description: "", config }, "u"),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it("keeps slug immutable for direct service callers", async () => {
    const repo = { updateBase: jest.fn(async () => ({ id: "a1" })) };
    const { app } = service(repo);
    await app.updateBase("a1", { slug: "rogue" } as never, "u");
    expect(repo.updateBase).toHaveBeenCalledWith("a1", { updatedBy: "u" });
  });
});
