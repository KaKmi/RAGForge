import { BadRequestException, ConflictException } from "@nestjs/common";
import { KnowledgeBasesService } from "../src/modules/knowledge-bases/knowledge-bases.service";
import type { KnowledgeBasesRepository } from "../src/modules/knowledge-bases/knowledge-bases.repository";
import type { ModelsService } from "../src/modules/models/models.service";
import type { KbRebuildService } from "../src/modules/ingestion/kb-rebuild.service";
import type { KnowledgeBaseRow } from "../src/modules/knowledge-bases/schema";

function baseRow(overrides: Partial<KnowledgeBaseRow> = {}): KnowledgeBaseRow {
  return {
    id: "kb1",
    name: "kb",
    desc: "",
    chunkTemplate: "general",
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
  return { repo, models, kbRebuild };
}

function makeSvc(deps: ReturnType<typeof makeDeps>): KnowledgeBasesService {
  return new KnowledgeBasesService(
    deps.repo as unknown as KnowledgeBasesRepository,
    deps.models as unknown as ModelsService,
    deps.kbRebuild as unknown as KbRebuildService,
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
    await expect(
      makeSvc(deps).update("kb1", { embeddingModelId: "m2" } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it("改 chunkTemplate 触发 KbRebuildService.startRebuild", async () => {
    const deps = makeDeps();
    deps.repo.findById.mockResolvedValue(baseRow({ chunkTemplate: "general" }));
    deps.repo.update.mockResolvedValue(baseRow({ chunkTemplate: "qa" }));
    await makeSvc(deps).update("kb1", { chunkTemplate: "qa" });
    expect(deps.kbRebuild.startRebuild).toHaveBeenCalledWith("kb1");
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
