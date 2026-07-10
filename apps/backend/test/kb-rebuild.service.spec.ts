import { BadRequestException, ConflictException } from "@nestjs/common";
import { KbRebuildService } from "../src/modules/ingestion/kb-rebuild.service";
import type { KnowledgeBasesRepository } from "../src/modules/knowledge-bases/knowledge-bases.repository";
import type { DocumentsRepository } from "../src/modules/documents/documents.repository";
import type { ChunksRepository } from "../src/modules/chunks/chunks.repository";
import type { IngestionService } from "../src/modules/ingestion/ingestion.service";
import type { AppConfigService } from "../src/platform/config/config.service";

function makeDeps(processingProfilesEnabled = true) {
  const kbRepo = { findById: jest.fn(), updateVersions: jest.fn() };
  const docsRepo = { findByKb: jest.fn() };
  const chunksRepo = { deleteByVersion: jest.fn(async () => 0) };
  const ingestion = { enqueue: jest.fn(), createRun: jest.fn() };
  const config = { processingProfilesEnabled } as unknown as AppConfigService;
  return { kbRepo, docsRepo, chunksRepo, ingestion, config };
}

function makeService(deps: ReturnType<typeof makeDeps>): KbRebuildService {
  return new KbRebuildService(
    deps.kbRepo as unknown as KnowledgeBasesRepository,
    deps.docsRepo as unknown as DocumentsRepository,
    deps.chunksRepo as unknown as ChunksRepository,
    deps.ingestion as unknown as IngestionService,
    deps.config,
  );
}

describe("KbRebuildService.startRebuild", () => {
  it("设置 building_version = active_version+1，为每个文档建 Run（flag 开启，默认 scope='all'）", async () => {
    const deps = makeDeps();
    deps.kbRepo.findById.mockResolvedValue({ id: "kb1", activeVersion: 1, buildingVersion: null });
    deps.docsRepo.findByKb.mockResolvedValue([
      { id: "d1", profileOverrideId: null },
      { id: "d2", profileOverrideId: null },
    ]);

    await makeService(deps).startRebuild("kb1");

    expect(deps.kbRepo.updateVersions).toHaveBeenCalledWith("kb1", {
      buildingVersion: 2,
      status: "building",
    });
    expect(deps.ingestion.createRun).toHaveBeenCalledWith("d1");
    expect(deps.ingestion.createRun).toHaveBeenCalledWith("d2");
  });

  it("scope='inherited'：只对 profileOverrideId 为 null 的文档建 Run", async () => {
    const deps = makeDeps();
    deps.kbRepo.findById.mockResolvedValue({ id: "kb1", activeVersion: 1, buildingVersion: null });
    deps.docsRepo.findByKb.mockResolvedValue([
      { id: "d1", profileOverrideId: null },
      { id: "d2", profileOverrideId: "faq-v1" },
      { id: "d3", profileOverrideId: null },
    ]);

    await makeService(deps).startRebuild("kb1", "inherited");

    expect(deps.ingestion.createRun).toHaveBeenCalledWith("d1");
    expect(deps.ingestion.createRun).toHaveBeenCalledWith("d3");
    expect(deps.ingestion.createRun).not.toHaveBeenCalledWith("d2");
    expect(deps.ingestion.createRun).toHaveBeenCalledTimes(2);
  });

  it("flag=false（legacy 回退）：为每个文档以新版本 enqueue，不建 Run", async () => {
    const deps = makeDeps(false);
    deps.kbRepo.findById.mockResolvedValue({ id: "kb1", activeVersion: 1, buildingVersion: null });
    deps.docsRepo.findByKb.mockResolvedValue([
      { id: "d1", profileOverrideId: null },
      { id: "d2", profileOverrideId: null },
    ]);

    await makeService(deps).startRebuild("kb1");

    expect(deps.ingestion.enqueue).toHaveBeenCalledWith("d1", 2);
    expect(deps.ingestion.enqueue).toHaveBeenCalledWith("d2", 2);
    expect(deps.ingestion.createRun).not.toHaveBeenCalled();
  });

  it("重建循环内单文档 createRun 抛 409（已有进行中任务）→ 跳过该文档继续，不中断整轮（review P1 回归）", async () => {
    const deps = makeDeps();
    deps.kbRepo.findById.mockResolvedValue({ id: "kb1", activeVersion: 1, buildingVersion: null });
    deps.docsRepo.findByKb.mockResolvedValue([
      { id: "d1", profileOverrideId: null },
      { id: "d2", profileOverrideId: null },
      { id: "d3", profileOverrideId: null },
    ]);
    // d2 已有进行中 Run → createRun 抛 409；d1/d3 正常。
    deps.ingestion.createRun
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ConflictException("该文档已有处理任务进行中"))
      .mockResolvedValueOnce(undefined);

    await expect(makeService(deps).startRebuild("kb1")).resolves.toBeUndefined();
    // 三个文档都被尝试（循环没有在 d2 中断）。
    expect(deps.ingestion.createRun).toHaveBeenCalledTimes(3);
    expect(deps.ingestion.createRun).toHaveBeenCalledWith("d3");
    // KB 已置 building，不因单文档冲突回滚。
    expect(deps.kbRepo.updateVersions).toHaveBeenCalledWith("kb1", {
      buildingVersion: 2,
      status: "building",
    });
  });

  it("重建循环内单文档 createRun 抛 400（Profile 版本已移除）→ 跳过继续，不中断整轮（review P2 回归）", async () => {
    const deps = makeDeps();
    deps.kbRepo.findById.mockResolvedValue({ id: "kb1", activeVersion: 1, buildingVersion: null });
    deps.docsRepo.findByKb.mockResolvedValue([
      { id: "d1", profileOverrideId: null },
      { id: "d2", profileOverrideId: null },
      { id: "d3", profileOverrideId: null },
    ]);
    // d2 引用已从注册表移除的 Profile 版本 → createRun 抛 BadRequestException。
    deps.ingestion.createRun
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new BadRequestException("[PROFILE_VERSION_UNAVAILABLE] 处理方案不可用"))
      .mockResolvedValueOnce(undefined);

    await expect(makeService(deps).startRebuild("kb1")).resolves.toBeUndefined();
    expect(deps.ingestion.createRun).toHaveBeenCalledTimes(3);
    expect(deps.ingestion.createRun).toHaveBeenCalledWith("d3");
    expect(deps.kbRepo.updateVersions).toHaveBeenCalledWith("kb1", {
      buildingVersion: 2,
      status: "building",
    });
  });

  it("重建循环内单文档 createRun 抛非预期错误（如 DB 故障）→ 照抛，不静默吞掉", async () => {
    const deps = makeDeps();
    deps.kbRepo.findById.mockResolvedValue({ id: "kb1", activeVersion: 1, buildingVersion: null });
    deps.docsRepo.findByKb.mockResolvedValue([{ id: "d1", profileOverrideId: null }]);
    deps.ingestion.createRun.mockRejectedValueOnce(new Error("connection reset"));
    await expect(makeService(deps).startRebuild("kb1")).rejects.toThrow(/connection reset/);
  });

  it("kb 已在 building 中时抛 ConflictException(409)，不重复发任务", async () => {
    const deps = makeDeps();
    deps.kbRepo.findById.mockResolvedValue({ id: "kb1", activeVersion: 1, buildingVersion: 2 });

    await expect(makeService(deps).startRebuild("kb1")).rejects.toBeInstanceOf(ConflictException);
    expect(deps.ingestion.createRun).not.toHaveBeenCalled();
    expect(deps.kbRepo.updateVersions).not.toHaveBeenCalled();
  });

  it("kb 不存在时静默返回，不改版本、不入队", async () => {
    const deps = makeDeps();
    deps.kbRepo.findById.mockResolvedValue(undefined);

    await expect(makeService(deps).startRebuild("gone")).resolves.toBeUndefined();
    expect(deps.kbRepo.updateVersions).not.toHaveBeenCalled();
    expect(deps.ingestion.createRun).not.toHaveBeenCalled();
  });

  it("空库：无文档可建 Run -> 直接原子切换到新版本 + 清理旧版本切片", async () => {
    const deps = makeDeps();
    deps.kbRepo.findById.mockResolvedValue({ id: "kb1", activeVersion: 3, buildingVersion: null });
    deps.docsRepo.findByKb.mockResolvedValue([]);

    await makeService(deps).startRebuild("kb1");

    expect(deps.ingestion.createRun).not.toHaveBeenCalled();
    expect(deps.kbRepo.updateVersions).toHaveBeenCalledWith("kb1", {
      buildingVersion: 4,
      status: "building",
    });
    expect(deps.kbRepo.updateVersions).toHaveBeenCalledWith("kb1", {
      activeVersion: 4,
      buildingVersion: null,
      status: "ready",
    });
    expect(deps.chunksRepo.deleteByVersion).toHaveBeenCalledWith("kb1", 3);
  });

  it("scope='inherited' 且全部文档都被 override 排除 → 空范围，直接原子切换", async () => {
    const deps = makeDeps();
    deps.kbRepo.findById.mockResolvedValue({ id: "kb1", activeVersion: 1, buildingVersion: null });
    deps.docsRepo.findByKb.mockResolvedValue([
      { id: "d1", profileOverrideId: "faq-v1" },
      { id: "d2", profileOverrideId: "course-wechat-v1" },
    ]);

    await makeService(deps).startRebuild("kb1", "inherited");

    expect(deps.ingestion.createRun).not.toHaveBeenCalled();
    expect(deps.kbRepo.updateVersions).toHaveBeenCalledWith("kb1", {
      activeVersion: 2,
      buildingVersion: null,
      status: "ready",
    });
  });
});

describe("KbRebuildService.onDocumentTerminal", () => {
  it("仍有文档未到终态（queued/processing）时不切换", async () => {
    const deps = makeDeps();
    deps.kbRepo.findById.mockResolvedValue({ id: "kb1", activeVersion: 1, buildingVersion: 2 });
    deps.docsRepo.findByKb.mockResolvedValue([
      { id: "d1", status: "ready" },
      { id: "d2", status: "processing" },
    ]);

    await makeService(deps).onDocumentTerminal("kb1");

    expect(deps.kbRepo.updateVersions).not.toHaveBeenCalled();
    expect(deps.chunksRepo.deleteByVersion).not.toHaveBeenCalled();
  });

  it("全部到终态（ready 或 failed 混合）时原子切换 active/building + 触发旧版本异步清理", async () => {
    const deps = makeDeps();
    deps.kbRepo.findById.mockResolvedValue({ id: "kb1", activeVersion: 1, buildingVersion: 2 });
    deps.docsRepo.findByKb.mockResolvedValue([
      { id: "d1", status: "ready" },
      { id: "d2", status: "failed" }, // 部分失败不卡住整体切换（007 拍板）
    ]);

    await makeService(deps).onDocumentTerminal("kb1");

    expect(deps.kbRepo.updateVersions).toHaveBeenCalledWith("kb1", {
      activeVersion: 2,
      buildingVersion: null,
      status: "ready",
    });
    expect(deps.chunksRepo.deleteByVersion).toHaveBeenCalledWith("kb1", 1);
  });

  it("kb 当前不在 building 中（buildingVersion=null）时是 no-op（普通单文档入库场景）", async () => {
    const deps = makeDeps();
    deps.kbRepo.findById.mockResolvedValue({ id: "kb1", activeVersion: 1, buildingVersion: null });

    await makeService(deps).onDocumentTerminal("kb1");

    expect(deps.docsRepo.findByKb).not.toHaveBeenCalled();
    expect(deps.kbRepo.updateVersions).not.toHaveBeenCalled();
  });

  it("kb 不存在时 no-op", async () => {
    const deps = makeDeps();
    deps.kbRepo.findById.mockResolvedValue(undefined);

    await makeService(deps).onDocumentTerminal("gone");

    expect(deps.docsRepo.findByKb).not.toHaveBeenCalled();
    expect(deps.kbRepo.updateVersions).not.toHaveBeenCalled();
  });

  // 回归：QA 独立复现的死锁——重建期间上传 autoParse=false 新文档（停在 pending，永不入队、
  // 永不到达终态）不应阻塞已入队文档全部就绪后的切换。用同一 service 实例先 startRebuild 落快照，
  // 再模拟"新文档在重建期间出现在 findByKb 结果里"，验证 onDocumentTerminal 只认快照里的文档。
  it("重建期间新上传的 pending 文档不计入终态判定，不阻塞切换", async () => {
    const deps = makeDeps();
    deps.kbRepo.findById.mockResolvedValue({ id: "kb1", activeVersion: 1, buildingVersion: null });
    deps.docsRepo.findByKb.mockResolvedValue([{ id: "d1" }, { id: "d2" }]);
    const service = makeService(deps);
    await service.startRebuild("kb1");

    // 重建触发后 kb 进入 building，后续查询需反映该态；同时 findByKb 现在多出一个重建期间新上传的 pending 文档。
    deps.kbRepo.findById.mockResolvedValue({ id: "kb1", activeVersion: 1, buildingVersion: 2 });
    deps.docsRepo.findByKb.mockResolvedValue([
      { id: "d1", status: "ready" },
      { id: "d2", status: "ready" },
      { id: "d3-pending-during-rebuild", status: "pending" },
    ]);

    await service.onDocumentTerminal("kb1");

    expect(deps.kbRepo.updateVersions).toHaveBeenCalledWith("kb1", {
      activeVersion: 2,
      buildingVersion: null,
      status: "ready",
    });
    expect(deps.chunksRepo.deleteByVersion).toHaveBeenCalledWith("kb1", 1);
  });

  it("快照里的文档被中途删除（不再出现在 findByKb）时不阻塞切换", async () => {
    const deps = makeDeps();
    deps.kbRepo.findById.mockResolvedValue({ id: "kb1", activeVersion: 1, buildingVersion: null });
    deps.docsRepo.findByKb.mockResolvedValue([{ id: "d1" }, { id: "d2" }]);
    const service = makeService(deps);
    await service.startRebuild("kb1");

    deps.kbRepo.findById.mockResolvedValue({ id: "kb1", activeVersion: 1, buildingVersion: 2 });
    // d2 被删除（级联走了），findByKb 只剩 d1。
    deps.docsRepo.findByKb.mockResolvedValue([{ id: "d1", status: "ready" }]);

    await service.onDocumentTerminal("kb1");

    expect(deps.kbRepo.updateVersions).toHaveBeenCalledWith("kb1", {
      activeVersion: 2,
      buildingVersion: null,
      status: "ready",
    });
  });
});
