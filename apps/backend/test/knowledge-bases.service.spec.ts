import { BadRequestException, ConflictException } from "@nestjs/common";
import { KnowledgeBasesService } from "../src/modules/knowledge-bases/knowledge-bases.service";
import type { KnowledgeBasesRepository } from "../src/modules/knowledge-bases/knowledge-bases.repository";
import type { DocumentsRepository } from "../src/modules/documents/documents.repository";
import type { ChunksRepository } from "../src/modules/chunks/chunks.repository";
import type { ModelsService } from "../src/modules/models/models.service";
import type { KbRebuildService } from "../src/modules/ingestion/kb-rebuild.service";
import {
  PROCESSING_PROFILES,
  ProfileRegistry,
} from "../src/modules/ingestion/profiles/profile-registry";
import type { KnowledgeBaseRow } from "../src/modules/knowledge-bases/schema";

function baseRow(overrides: Partial<KnowledgeBaseRow> = {}): KnowledgeBaseRow {
  return {
    id: "kb1",
    name: "kb",
    desc: "",
    chunkTemplate: "general",
    defaultProfileId: "general-v1",
    defaultProfileVersion: 1,
    embeddingModelId: "m1",
    status: "ready",
    activeVersion: 1,
    buildingVersion: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeDeps() {
  const repo = {
    find: jest.fn(async () => [] as KnowledgeBaseRow[]),
    findById: jest.fn(async () => undefined as KnowledgeBaseRow | undefined),
    findByName: jest.fn(async () => undefined as KnowledgeBaseRow | undefined),
    insert: jest.fn(async (row: object) => baseRow(row as Partial<KnowledgeBaseRow>)),
    update: jest.fn(async (id: string, patch: object) =>
      baseRow({ id, ...(patch as Partial<KnowledgeBaseRow>) }),
    ),
  };
  const models = {
    get: jest.fn(async () => ({ id: "m1", type: "embedding", enabled: true })),
    embedTexts: jest.fn(async () => [Array.from({ length: 1024 }, () => 0.1)]),
  };
  const kbRebuild = { startRebuild: jest.fn(async () => undefined) };
  const docsRepo = {
    countByKbs: jest.fn(async () => [] as Array<{ kbId: string; count: number }>),
  };
  const chunksRepo = {
    countByKbVersions: jest.fn(
      async () => [] as Array<{ kbId: string; version: number; count: number }>,
    ),
  };
  const registry = new ProfileRegistry(structuredClone(PROCESSING_PROFILES));
  return { repo, models, kbRebuild, docsRepo, chunksRepo, registry };
}

function makeSvc(deps: ReturnType<typeof makeDeps>): KnowledgeBasesService {
  return new KnowledgeBasesService(
    deps.repo as unknown as KnowledgeBasesRepository,
    deps.docsRepo as unknown as DocumentsRepository,
    deps.chunksRepo as unknown as ChunksRepository,
    deps.models as unknown as ModelsService,
    deps.kbRebuild as unknown as KbRebuildService,
    deps.registry,
  );
}

const createReq = {
  name: "x",
  desc: "",
  chunkTemplate: "general" as const,
  embeddingModelId: "m1",
};

describe("KnowledgeBasesService.create", () => {
  it("名称重复抛 409", async () => {
    const deps = makeDeps();
    deps.repo.findByName.mockResolvedValue(baseRow({ id: "existing", name: "dup" }));
    await expect(makeSvc(deps).create({ ...createReq, name: "dup" })).rejects.toThrow(
      ConflictException,
    );
    expect(deps.repo.insert).not.toHaveBeenCalled();
  });

  it("embeddingModelId 指向非 embedding 类型模型抛 400", async () => {
    const deps = makeDeps();
    deps.models.get.mockResolvedValue({ id: "m1", type: "llm", enabled: true });
    await expect(makeSvc(deps).create(createReq)).rejects.toThrow(BadRequestException);
    expect(deps.models.embedTexts).not.toHaveBeenCalled();
  });

  it("embeddingModelId 指向已禁用（disabled）模型抛 400", async () => {
    const deps = makeDeps();
    deps.models.get.mockResolvedValue({ id: "m1", type: "embedding", enabled: false });
    await expect(makeSvc(deps).create(createReq)).rejects.toThrow(BadRequestException);
  });

  it("embedding 探针返回非 1024 维时抛 400", async () => {
    const deps = makeDeps();
    deps.models.embedTexts.mockResolvedValue([[0.1, 0.2]]); // 只有 2 维
    await expect(makeSvc(deps).create(createReq)).rejects.toThrow(BadRequestException);
    expect(deps.repo.insert).not.toHaveBeenCalled();
  });

  it("embedTexts 抛错（如底层维度校验）转成 400", async () => {
    const deps = makeDeps();
    deps.models.embedTexts.mockRejectedValue(new Error("embedding 维度不是 1024（实际 512）"));
    await expect(makeSvc(deps).create(createReq)).rejects.toThrow(BadRequestException);
  });

  it("校验通过：真实调探针、落库并返回，activeVersion=1", async () => {
    const deps = makeDeps();
    const kb = await makeSvc(deps).create(createReq);
    expect(deps.models.embedTexts).toHaveBeenCalledWith("m1", ["probe"]);
    expect(kb.activeVersion).toBe(1);
    expect(deps.repo.insert).toHaveBeenCalled();
  });
});

describe("KnowledgeBasesService.update", () => {
  it("携带 embeddingModelId 会被拒绝（创建后锁定）→ 400", async () => {
    const deps = makeDeps();
    deps.repo.findById.mockResolvedValue(baseRow());
    await expect(makeSvc(deps).update("kb1", { embeddingModelId: "m2" } as never)).rejects.toThrow(
      BadRequestException,
    );
  });

  it("改 chunkTemplate 触发 KbRebuildService.startRebuild(id,'all') + 双写 defaultProfile*", async () => {
    const deps = makeDeps();
    deps.repo.findById.mockResolvedValue(baseRow({ chunkTemplate: "general" }));
    deps.repo.update.mockResolvedValue(baseRow({ chunkTemplate: "qa" }));
    await makeSvc(deps).update("kb1", { chunkTemplate: "qa" });
    expect(deps.repo.update).toHaveBeenCalledWith(
      "kb1",
      expect.objectContaining({ chunkTemplate: "qa", defaultProfileId: "faq-v1", defaultProfileVersion: 1 }),
    );
    expect(deps.kbRebuild.startRebuild).toHaveBeenCalledWith("kb1", "all");
  });

  it("重建中再次改 chunkTemplate → 409，不再触发重建", async () => {
    const deps = makeDeps();
    deps.repo.findById.mockResolvedValue(
      baseRow({ chunkTemplate: "general", buildingVersion: 2, status: "building" }),
    );
    await expect(makeSvc(deps).update("kb1", { chunkTemplate: "qa" })).rejects.toThrow(
      ConflictException,
    );
    expect(deps.kbRebuild.startRebuild).not.toHaveBeenCalled();
    expect(deps.repo.update).not.toHaveBeenCalled();
  });

  it("不改 chunkTemplate 时不触发重建", async () => {
    const deps = makeDeps();
    deps.repo.findById.mockResolvedValue(baseRow({ chunkTemplate: "general" }));
    deps.repo.update.mockResolvedValue(baseRow({ desc: "new desc" }));
    await makeSvc(deps).update("kb1", { desc: "new desc" });
    expect(deps.kbRebuild.startRebuild).not.toHaveBeenCalled();
  });

  it("同值 chunkTemplate（未变化）不触发重建", async () => {
    const deps = makeDeps();
    deps.repo.findById.mockResolvedValue(baseRow({ chunkTemplate: "general" }));
    deps.repo.update.mockResolvedValue(baseRow({ chunkTemplate: "general" }));
    await makeSvc(deps).update("kb1", { chunkTemplate: "general" });
    expect(deps.kbRebuild.startRebuild).not.toHaveBeenCalled();
  });
});

describe("KnowledgeBasesService 迁移窗口矩阵", () => {
  it("create 带 profile → 落 defaultProfile* 且反写 chunkTemplate=profile.chunker.id", async () => {
    const deps = makeDeps();
    await makeSvc(deps).create({
      name: "x",
      desc: "",
      processingProfileId: "faq-v1",
      processingProfileVersion: 1,
      embeddingModelId: "m1",
    } as never);
    expect(deps.repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultProfileId: "faq-v1",
        defaultProfileVersion: 1,
        chunkTemplate: "qa", // faq-v1.chunker.id
      }),
    );
  });

  it("create 只带 chunkTemplate（旧前端）→ 反查映射落 defaultProfile*（general→general-v1）", async () => {
    const deps = makeDeps();
    await makeSvc(deps).create({ name: "x", desc: "", chunkTemplate: "general", embeddingModelId: "m1" } as never);
    expect(deps.repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        chunkTemplate: "general",
        defaultProfileId: "general-v1",
        defaultProfileVersion: 1,
      }),
    );
  });

  it("create 同传 chunkTemplate+profile（绕过契约的非 HTTP 路径）→ chunkTemplate 由 profile 反写，不采信调用方", async () => {
    const deps = makeDeps();
    await makeSvc(deps).create({
      name: "x",
      desc: "",
      chunkTemplate: "general",
      processingProfileId: "faq-v1",
      processingProfileVersion: 1,
      embeddingModelId: "m1",
    } as never);
    // 纵深防御：即便同传，落库 chunkTemplate 也取 faq-v1 的 chunker（qa），与 defaultProfile* 一致。
    expect(deps.repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ chunkTemplate: "qa", defaultProfileId: "faq-v1", defaultProfileVersion: 1 }),
    );
  });

  it("create profile 未注册 → 400，不落库", async () => {
    const deps = makeDeps();
    await expect(
      makeSvc(deps).create({
        name: "x",
        desc: "",
        processingProfileId: "ghost",
        processingProfileVersion: 9,
        embeddingModelId: "m1",
      } as never),
    ).rejects.toThrow(BadRequestException);
    expect(deps.repo.insert).not.toHaveBeenCalled();
  });

  it("PATCH 带 profile 且变更 → 更新 defaultProfile* + 反写 chunkTemplate，不调用 startRebuild", async () => {
    const deps = makeDeps();
    deps.repo.findById.mockResolvedValue(
      baseRow({ defaultProfileId: "general-v1", defaultProfileVersion: 1, chunkTemplate: "general" }),
    );
    deps.repo.update.mockResolvedValue(baseRow({ chunkTemplate: "qa" }));
    await makeSvc(deps).update("kb1", { processingProfileId: "faq-v1", processingProfileVersion: 1 } as never);
    expect(deps.repo.update).toHaveBeenCalledWith(
      "kb1",
      expect.objectContaining({ defaultProfileId: "faq-v1", defaultProfileVersion: 1, chunkTemplate: "qa" }),
    );
    expect(deps.kbRebuild.startRebuild).not.toHaveBeenCalled();
  });

  it("PATCH 带 profile 但 KB 正在 building → 409", async () => {
    const deps = makeDeps();
    deps.repo.findById.mockResolvedValue(
      baseRow({ defaultProfileId: "general-v1", defaultProfileVersion: 1, buildingVersion: 2, status: "building" }),
    );
    await expect(
      makeSvc(deps).update("kb1", { processingProfileId: "faq-v1", processingProfileVersion: 1 } as never),
    ).rejects.toThrow(ConflictException);
    expect(deps.repo.update).not.toHaveBeenCalled();
  });

  it("rebuild(id, scope) → 透传 KbRebuildService.startRebuild(id, scope)", async () => {
    const deps = makeDeps();
    deps.repo.findById.mockResolvedValue(baseRow());
    await makeSvc(deps).rebuild("kb1", "inherited");
    expect(deps.kbRebuild.startRebuild).toHaveBeenCalledWith("kb1", "inherited");
  });
});

describe("KnowledgeBasesService 计数填充（QA 回归：卡片不再恒 0）", () => {
  it("list 按 kb 填充 docsCount、按 activeVersion 挑行填充 chunksCount", async () => {
    const deps = makeDeps();
    deps.repo.find.mockResolvedValue([baseRow({ id: "kb1", activeVersion: 2 })]);
    deps.docsRepo.countByKbs.mockResolvedValue([{ kbId: "kb1", count: 3 }]);
    deps.chunksRepo.countByKbVersions.mockResolvedValue([
      { kbId: "kb1", version: 1, count: 50 }, // 旧版本切片（待清理），不得计入
      { kbId: "kb1", version: 2, count: 12 },
    ]);
    const svc = makeSvc(deps);
    const list = await svc.list();
    expect(list[0].docsCount).toBe(3);
    expect(list[0].chunksCount).toBe(12);
  });
});
