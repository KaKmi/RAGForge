import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
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
      evalGateEnabled: false,
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
    findTagNamesByAppIds: jest.fn(async () => new Map<string, string[]>()),
    findTagsWithVersion: jest.fn(async () => [{ name: "qa1", versionId: "v1", version: 1 }]),
    upsertTag: jest.fn(async () => undefined),
    deleteTag: jest.fn(async () => 1),
    countTags: jest.fn(async () => 0),
    tagExists: jest.fn(async () => false),
    casProduction: jest.fn(async () => "ok"),
    clearProduction: jest.fn(async () => "ok"),
    insertReleaseCheck: jest.fn(async (row: Record<string, unknown>) => ({
      id: "rc1",
      status: "queued",
      issues: [],
      sampleSummary: {},
      startedAt: null,
      finishedAt: null,
      expiresAt: null,
      createdAt: now,
      ...row,
    })),
    findReleaseCheckById: jest.fn(async () => undefined),
    ...overrides,
  };
  const kbs = {
    findByIds: jest.fn(async () => [{ id: "kb", embeddingModelId: "embed", activeVersion: 1 }]),
  };
  const models = {
    get: jest.fn(async () => ({
      id: "llm",
      type: "llm",
      enabled: true,
      evalGateEnabled: false,
      params: {},
      baseUrl: "http://x",
      protocol: "openai_compat",
    })),
  };
  const prompts = {
    getVersionMeta: jest.fn(async (id: string) => ({
      promptId: "p",
      node: id.slice(2),
      version: 1,
      contractVersion: 1,
      compileStatus: "ok",
    })),
    getVersionExecutable: jest.fn(async (id: string) => ({
      node: id.slice(2),
      contractVersion: 1,
      body: `body-of-${id}`,
    })),
    listVersions: jest.fn(async () => []),
  };
  const releaseQueue = {
    publish: jest.fn(async () => undefined),
    subscribe: jest.fn(async () => undefined),
  };
  return {
    app: new ApplicationsService(
      repo as never,
      kbs as never,
      models as never,
      prompts as never,
      releaseQueue as never,
    ),
    repo,
    kbs,
    models,
    prompts,
    releaseQueue,
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
  it("validates an explicitly supplied rerank model even when rerank is disabled", async () => {
    const { app } = service();
    await expect(
      app.create(
        {
          slug: "after-sale",
          name: "售后",
          description: "",
          config: { ...config, retrieval: { ...config.retrieval, rerankModelId: "llm" } },
        },
        "u",
      ),
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

  // —— M7b S2 自定义标签 ——
  it("moves a custom tag exclusively and returns the tag list", async () => {
    const { app, repo } = service();
    const tags = await app.moveTag("a1", "qa1", "v1", "u");
    expect(repo.upsertTag).toHaveBeenCalledWith("a1", "v1", "qa1", "u");
    expect(tags).toEqual([{ name: "qa1", versionId: "v1", version: 1 }]);
  });
  it("rejects reserved words production/v at the service boundary", async () => {
    const { app, repo } = service();
    await expect(app.moveTag("a1", "production", "v1", "u")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(app.moveTag("a1", "v", "v1", "u")).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.upsertTag).not.toHaveBeenCalled();
  });
  it("rejects a 21st NEW tag but allows moving an existing tag past the cap", async () => {
    const capped = service({
      countTags: jest.fn(async () => 20),
      tagExists: jest.fn(async () => false),
    });
    await expect(capped.app.moveTag("a1", "qa21", "v1", "u")).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(capped.repo.upsertTag).not.toHaveBeenCalled();
    const moving = service({
      countTags: jest.fn(async () => 20),
      tagExists: jest.fn(async () => true),
    });
    await expect(moving.app.moveTag("a1", "qa1", "v2", "u")).resolves.toBeDefined();
    expect(moving.repo.upsertTag).toHaveBeenCalled();
  });
  it("404s when tagging a version owned by another application", async () => {
    const { app } = service({
      findVersionById: jest.fn(async () => ({ ...version, applicationId: "other" })),
    });
    await expect(app.moveTag("a1", "qa1", "v1", "u")).rejects.toBeInstanceOf(NotFoundException);
  });
  it("maps a concurrent composite-FK violation (23503) to 404", async () => {
    const fkErr = Object.assign(new Error("fk"), { code: "23503" });
    const { app } = service({
      upsertTag: jest.fn(async () => {
        throw fkErr;
      }),
    });
    await expect(app.moveTag("a1", "qa1", "v1", "u")).rejects.toBeInstanceOf(NotFoundException);
  });
  it("removes a tag case-insensitively and 404s when absent", async () => {
    const { app, repo } = service();
    await app.removeTag("a1", "QA1");
    expect(repo.deleteTag).toHaveBeenCalledWith("a1", "qa1");
    const absent = service({ deleteTag: jest.fn(async () => 0) });
    await expect(absent.app.removeTag("a1", "nope")).rejects.toBeInstanceOf(NotFoundException);
  });

  // review P2-1：直接调用方（大写保留字）必须被 service 归一后拦下，不得落 production 等价标签行
  it("normalizes a direct-caller uppercase reserved word and rejects it", async () => {
    const { app, repo } = service();
    await expect(app.moveTag("a1", "Production", "v1", "u")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repo.upsertTag).not.toHaveBeenCalled();
  });

  // —— M7b S4 ReleaseCheck ——
  it("startReleaseCheck：静态门禁通过 → 建 queued check 并入队（幂等 singletonKey）", async () => {
    const { app, repo, releaseQueue } = service();
    const check = await app.startReleaseCheck("a1", "v1", "u");
    expect(check.status).toBe("queued");
    expect(repo.insertReleaseCheck).toHaveBeenCalled();
    expect(releaseQueue.publish).toHaveBeenCalledWith(
      "application.release_check",
      { checkId: "rc1" },
      { singletonKey: "rc1", retryLimit: 1 }, // review P2-2：崩溃恢复需重投一次，终态守卫防重复计费
    );
  });
  it("startReleaseCheck：无知识库 → 422 且不入队", async () => {
    const { app, releaseQueue } = service({ findVersionKbIds: jest.fn(async () => []) });
    await expect(app.startReleaseCheck("a1", "v1", "u")).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(releaseQueue.publish).not.toHaveBeenCalled();
  });
  // —— M7b S5 production 受门禁 CAS ——
  const futureCheck = (fp: string, over: Record<string, unknown> = {}) => ({
    id: "rc1",
    applicationId: "a1",
    configVersionId: "v1",
    configFingerprint: fp,
    status: "passed",
    issues: [],
    sampleSummary: {},
    startedAt: now,
    finishedAt: now,
    expiresAt: new Date(Date.now() + 60_000),
    createdBy: "u",
    createdAt: now,
    ...over,
  });
  const publishReq = { versionId: "v1", releaseCheckId: "rc1", expectedProductionVersionId: null };

  it("publish happy：passed+未过期+fingerprint 匹配 → CAS 移动指针", async () => {
    const s = service();
    const fp = await s.app.computeVersionFingerprint(version as never);
    s.repo.findReleaseCheckById = jest.fn(async () => futureCheck(fp));
    await expect(s.app.publishProduction("a1", publishReq, "u")).resolves.toBeDefined();
    expect(s.repo.casProduction).toHaveBeenCalledWith("a1", "v1", null, "u");
  });
  it("publish：check 非 passed → 422", async () => {
    const s = service();
    const fp = await s.app.computeVersionFingerprint(version as never);
    s.repo.findReleaseCheckById = jest.fn(async () => futureCheck(fp, { status: "queued" }));
    await expect(s.app.publishProduction("a1", publishReq, "u")).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(s.repo.casProduction).not.toHaveBeenCalled();
  });
  it("publish：check 过期 → 409", async () => {
    const s = service();
    const fp = await s.app.computeVersionFingerprint(version as never);
    s.repo.findReleaseCheckById = jest.fn(async () =>
      futureCheck(fp, { expiresAt: new Date(Date.now() - 1000) }),
    );
    await expect(s.app.publishProduction("a1", publishReq, "u")).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
  it("publish：fingerprint 失配（依赖已变）→ 409", async () => {
    const s = service();
    s.repo.findReleaseCheckById = jest.fn(async () => futureCheck("stale-fingerprint"));
    await expect(s.app.publishProduction("a1", publishReq, "u")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(s.repo.casProduction).not.toHaveBeenCalled();
  });
  it("publish：check 归属异版本 → 404", async () => {
    const s = service();
    const fp = await s.app.computeVersionFingerprint(version as never);
    s.repo.findReleaseCheckById = jest.fn(async () =>
      futureCheck(fp, { configVersionId: "other" }),
    );
    await expect(s.app.publishProduction("a1", publishReq, "u")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
  it("publish：CAS 并发冲突 → 409；归属守卫失败 → 400", async () => {
    const conflict = service({ casProduction: jest.fn(async () => "cas_conflict") });
    const fp1 = await conflict.app.computeVersionFingerprint(version as never);
    conflict.repo.findReleaseCheckById = jest.fn(async () => futureCheck(fp1));
    await expect(conflict.app.publishProduction("a1", publishReq, "u")).rejects.toBeInstanceOf(
      ConflictException,
    );
    const owner = service({ casProduction: jest.fn(async () => "ownership_fail") });
    const fp2 = await owner.app.computeVersionFingerprint(version as never);
    owner.repo.findReleaseCheckById = jest.fn(async () => futureCheck(fp2));
    await expect(owner.app.publishProduction("a1", publishReq, "u")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
  it("unpublish：CAS 清指针；并发冲突 → 409", async () => {
    const ok = service();
    await expect(ok.app.unpublishProduction("a1", "v1", "u")).resolves.toBeDefined();
    expect(ok.repo.clearProduction).toHaveBeenCalledWith("a1", "v1", "u");
    const conflict = service({ clearProduction: jest.fn(async () => "cas_conflict") });
    await expect(conflict.app.unpublishProduction("a1", "v1", "u")).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  // —— M7b S6 resolver（拒绝序 deleted → disabled → 目标缺失 → resolved）——
  const appRow = (over: Record<string, unknown> = {}) => ({
    id: "a1",
    slug: "after-sale",
    name: "售后",
    description: "",
    enabled: true,
    evalGateEnabled: false,
    productionConfigVersionId: "v1",
    productionVersion: 1,
    latestVersion: 1,
    versionCount: 1,
    createdBy: "u",
    updatedBy: "u",
    createdAt: now,
    updatedAt: now,
    ...over,
  });

  it("resolvePublic：应用缺失/软删 → 404（byId 已过滤 + bySlug 显式判）", async () => {
    const { app } = service({
      findApplicationById: jest.fn(async () => undefined),
      findBySlug: jest.fn(async () => undefined),
    });
    await expect(app.resolvePublic("nope")).rejects.toBeInstanceOf(NotFoundException);
    const softDeleted = service({
      findApplicationById: jest.fn(async () => undefined),
      findBySlug: jest.fn(async () => ({ id: "a1", deletedAt: now })),
    });
    await expect(softDeleted.app.resolvePublic("after-sale")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
  it("resolvePublic：停用 → 403；production 缺失 → 404", async () => {
    const disabled = service({
      findApplicationById: jest.fn(async () => appRow({ enabled: false })),
    });
    await expect(disabled.app.resolvePublic("a1")).rejects.toBeInstanceOf(ForbiddenException);
    const unpublished = service({
      findApplicationById: jest.fn(async () => appRow({ productionConfigVersionId: null })),
    });
    await expect(unpublished.app.resolvePublic("a1")).rejects.toBeInstanceOf(NotFoundException);
  });
  it("resolvePublic happy：只读指针，preview=false，四节点带 promptBody", async () => {
    const { app } = service({ findApplicationById: jest.fn(async () => appRow()) });
    const resolved = await app.resolvePublic("a1");
    expect(resolved.preview).toBe(false);
    expect(resolved.configVersionId).toBe("v1");
    expect(resolved.nodes.reply.promptBody).toBe("body-of-p-reply");
    expect(resolved.kbIds).toEqual(["kb"]);
  });
  it("resolveByTag：自定义标签命中该版本，preview=true；标签缺失 → 404", async () => {
    const { app } = service({ findApplicationById: jest.fn(async () => appRow()) });
    const resolved = await app.resolveByTag("a1", "QA1", "admin");
    expect(resolved.preview).toBe(true);
    expect(resolved.configVersionId).toBe("v1"); // fake findTagsWithVersion: qa1 → v1
    await expect(app.resolveByTag("a1", "nope", "admin")).rejects.toBeInstanceOf(NotFoundException);
  });
  it("resolveByTag：tag 省略或 production → 读指针；未上线 → 404", async () => {
    const { app } = service({ findApplicationById: jest.fn(async () => appRow()) });
    expect((await app.resolveByTag("a1", undefined, "admin")).configVersionId).toBe("v1");
    expect((await app.resolveByTag("a1", "production", "admin")).configVersionId).toBe("v1");
    const unpublished = service({
      findApplicationById: jest.fn(async () => appRow({ productionConfigVersionId: null })),
    });
    await expect(unpublished.app.resolveByTag("a1", undefined, "admin")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
  it("resolveForTest：显式版本，preview=true", async () => {
    const { app } = service();
    const resolved = await app.resolveForTest("a1", "v1", "admin");
    expect(resolved.preview).toBe(true);
    expect(resolved.version).toBe(1);
  });

  it("getReleaseCheck：归属校验 + 返回 DTO；异应用 → 404", async () => {
    const row = {
      id: "rc1",
      applicationId: "a1",
      configVersionId: "v1",
      configFingerprint: "fp",
      status: "passed",
      issues: [],
      sampleSummary: {},
      startedAt: now,
      finishedAt: now,
      expiresAt: now,
      createdBy: "u",
      createdAt: now,
    };
    const ok = service({ findReleaseCheckById: jest.fn(async () => row) });
    await expect(ok.app.getReleaseCheck("a1", "rc1")).resolves.toMatchObject({ status: "passed" });
    const wrong = service({
      findReleaseCheckById: jest.fn(async () => ({ ...row, applicationId: "other" })),
    });
    await expect(wrong.app.getReleaseCheck("a1", "rc1")).rejects.toBeInstanceOf(NotFoundException);
  });
});
