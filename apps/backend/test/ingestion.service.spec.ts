import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import type { ModuleRef } from "@nestjs/core";
import { IngestionService } from "../src/modules/ingestion/ingestion.service";
import type { Queue } from "../src/platform/queue/queue.port";
import type { BlobStore } from "../src/platform/storage/blob-store.port";
import type { DocumentsRepository } from "../src/modules/documents/documents.repository";
import type { KnowledgeBasesRepository } from "../src/modules/knowledge-bases/knowledge-bases.repository";
import type { ProcessingRunsRepository } from "../src/modules/ingestion/processing-runs.repository";
import type { IngestionPipelinePort } from "../src/modules/ingestion/ports/ingestion-pipeline.port";
import type { AppConfigService } from "../src/platform/config/config.service";
import { DocumentChangeNotifier } from "../src/platform/events/document-change.notifier";
import {
  PROCESSING_PROFILES,
  ProfileRegistry,
} from "../src/modules/ingestion/profiles/profile-registry";

type Row = Record<string, unknown>;

function makeDeps() {
  const queue: jest.Mocked<Queue> = { publish: jest.fn(), subscribe: jest.fn() };
  const blobStore: jest.Mocked<BlobStore> = {
    put: jest.fn(),
    get: jest.fn(async () => Buffer.from("hello")),
    delete: jest.fn(),
  };
  const docsRepo = {
    findById: jest.fn(),
    update: jest.fn(async (id: string, patch: unknown) => ({ id, ...(patch as object) })),
    appendLifecycleStage: jest.fn(),
    completeLifecycleStage: jest.fn(async () => true),
  };
  const kbRepo = { findById: jest.fn() };
  const pipeline: jest.Mocked<IngestionPipelinePort> = { run: jest.fn() };

  // Map 支撑的 runsRepo：模拟 partial unique dpr_active_doc_unique（同文档 queued/running 再 insert
  // → 抛 drizzle 包裹形状 err.cause.code=23505），以及 findByDocument 的 createdAt desc 排序。
  const runs = new Map<string, Row>();
  let runSeq = 0;
  const runsRepo = {
    insert: jest.fn(async (row: Row) => {
      for (const r of runs.values()) {
        if (r.documentId === row.documentId && (r.status === "queued" || r.status === "running")) {
          throw Object.assign(new Error("Failed query"), {
            cause: Object.assign(new Error("duplicate key"), {
              code: "23505",
              constraint: "dpr_active_doc_unique",
            }),
          });
        }
      }
      const id = `run-${++runSeq}`;
      const full: Row = { id, status: "queued", createdAt: new Date(), startedAt: null, ...row };
      runs.set(id, full);
      return full;
    }),
    findById: jest.fn(async (id: string) => runs.get(id)),
    findByDocument: jest.fn(async (docId: string) =>
      [...runs.values()]
        .filter((r) => r.documentId === docId)
        .sort((a, b) => +(b.createdAt as Date) - +(a.createdAt as Date)),
    ),
    update: jest.fn(async (id: string, patch: Row) => {
      const row = runs.get(id);
      if (row) runs.set(id, { ...row, ...patch });
      return runs.get(id);
    }),
  };
  const registry = new ProfileRegistry(structuredClone(PROCESSING_PROFILES));
  const config = { processingProfilesEnabled: true } as unknown as AppConfigService;
  return { queue, blobStore, docsRepo, kbRepo, pipeline, runs, runsRepo, registry, config };
}

function makeService(
  deps: ReturnType<typeof makeDeps>,
  moduleRef?: ModuleRef,
  changes?: DocumentChangeNotifier,
): IngestionService {
  return new IngestionService(
    deps.queue,
    deps.blobStore,
    deps.docsRepo as unknown as DocumentsRepository,
    deps.kbRepo as unknown as KnowledgeBasesRepository,
    deps.pipeline,
    deps.runsRepo as unknown as ProcessingRunsRepository,
    deps.registry,
    deps.config,
    moduleRef,
    changes,
  );
}

// 新路径 pipeline 结果（IngestionResult 全形状）：processRun 落 Run 成功态与 canonical 归档需要。
function pipelineResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    chunkCount: 2,
    markdown: "md",
    parsedText: "md",
    canonical: { markdown: "md", blocks: [], warnings: [], stats: { pages: 1, tables: 0, images: 0, ocrPages: 0 } },
    parserEngine: "pdf-parse",
    parserVersion: "2.4.5",
    warnings: [],
    metrics: { pages: 1 },
    ...overrides,
  };
}

// 模拟 Nest ModuleRef：把终态监听 token 解析到给定 listener（onDocumentTerminal mock）。
function makeModuleRef(onDocumentTerminal: jest.Mock): ModuleRef {
  return { get: jest.fn(() => ({ onDocumentTerminal })) } as unknown as ModuleRef;
}

describe("IngestionService.enqueue", () => {
  it("发布任务时 singletonKey=documentId、retryLimit=1，先标 queued", async () => {
    const deps = makeDeps();
    const svc = makeService(deps);
    await svc.enqueue("d1", 1);
    expect(deps.docsRepo.update).toHaveBeenCalledWith("d1", { status: "queued" });
    expect(deps.queue.publish).toHaveBeenCalledWith(
      "ingest-document",
      { documentId: "d1", targetVersion: 1 },
      { singletonKey: "d1", retryLimit: 1 },
    );
  });
});

describe("IngestionService.processDocument", () => {
  it("成功路径：processing -> pipeline.run -> ready + chunkVersion + lifecycle done", async () => {
    const deps = makeDeps();
    deps.docsRepo.findById.mockResolvedValue({
      id: "d1",
      kbId: "kb1",
      type: "text",
      blobKey: "kb/kb1/d1/original.txt",
    });
    deps.kbRepo.findById.mockResolvedValue({
      id: "kb1",
      chunkTemplate: "general",
      embeddingModelId: "m1",
    });
    deps.pipeline.run.mockResolvedValue({ chunkCount: 3, parsedText: "hello" });

    const svc = makeService(deps);
    await svc.processDocument("d1", 1);

    expect(deps.docsRepo.update).toHaveBeenCalledWith("d1", { status: "processing" });
    expect(deps.pipeline.run).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: "d1", kbId: "kb1", targetVersion: 1 }),
    );
    expect(deps.docsRepo.update).toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({
        status: "ready",
        chunkVersion: 1,
        parsedText: "hello",
        error: null,
      }),
    );
    expect(deps.docsRepo.appendLifecycleStage).toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({ stage: "ready", status: "done" }),
    );
    // 起始追加的 ingest/running 项必须被闭合（endedAt 落终点），否则 UI 永远显示进行中
    expect(deps.docsRepo.completeLifecycleStage).toHaveBeenCalledWith(
      "d1",
      "ingest",
      expect.objectContaining({ status: "done", endedAt: expect.any(String) }),
    );
  });

  it("文档已被删除（findById 返回 undefined）时静默返回，不抛错、不跑管线", async () => {
    const deps = makeDeps();
    deps.docsRepo.findById.mockResolvedValue(undefined);
    const svc = makeService(deps);
    await expect(svc.processDocument("gone", 1)).resolves.toBeUndefined();
    expect(deps.pipeline.run).not.toHaveBeenCalled();
    expect(deps.docsRepo.update).not.toHaveBeenCalled();
  });

  it("pipeline.run 抛错时：文档标记 failed + error 消息 + lifecycle failed，不重新抛出", async () => {
    const deps = makeDeps();
    deps.docsRepo.findById.mockResolvedValue({ id: "d1", kbId: "kb1", type: "pdf", blobKey: "x" });
    deps.kbRepo.findById.mockResolvedValue({
      id: "kb1",
      chunkTemplate: "general",
      embeddingModelId: "m1",
    });
    deps.pipeline.run.mockRejectedValue(new Error("解析失败：扫描件"));

    const svc = makeService(deps);
    await expect(svc.processDocument("d1", 1)).resolves.toBeUndefined();
    expect(deps.docsRepo.update).toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({ status: "failed", error: "解析失败：扫描件" }),
    );
    expect(deps.docsRepo.completeLifecycleStage).toHaveBeenCalledWith(
      "d1",
      "ingest",
      expect.objectContaining({ status: "failed", error: "解析失败：扫描件" }),
    );
    expect(deps.docsRepo.update).not.toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({ status: "ready" }),
    );
  });

  it("HOST 裁定：管线返回 chunkCount=0 时按失败处理（failed + 可读错误），不置 ready", async () => {
    const deps = makeDeps();
    deps.docsRepo.findById.mockResolvedValue({ id: "d1", kbId: "kb1", type: "text", blobKey: "x" });
    deps.kbRepo.findById.mockResolvedValue({
      id: "kb1",
      chunkTemplate: "general",
      embeddingModelId: "m1",
    });
    deps.pipeline.run.mockResolvedValue({ chunkCount: 0, parsedText: "" });

    const svc = makeService(deps);
    await expect(svc.processDocument("d1", 1)).resolves.toBeUndefined();
    expect(deps.docsRepo.update).toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({
        status: "failed",
        error: "[CHUNK_EMPTY] 解析结果为空，未产生任何切片",
      }),
    );
    expect(deps.docsRepo.update).not.toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({ status: "ready" }),
    );
  });

  it("失败时若无未闭合 running 项（历史数据）：回退追加独立的 ingest/failed 项", async () => {
    const deps = makeDeps();
    deps.docsRepo.findById.mockResolvedValue({ id: "d1", kbId: "kb1", type: "pdf", blobKey: "x" });
    deps.kbRepo.findById.mockResolvedValue({
      id: "kb1",
      chunkTemplate: "general",
      embeddingModelId: "m1",
    });
    deps.pipeline.run.mockRejectedValue(new Error("boom"));
    deps.docsRepo.completeLifecycleStage.mockResolvedValue(false);

    const svc = makeService(deps);
    await expect(svc.processDocument("d1", 1)).resolves.toBeUndefined();
    expect(deps.docsRepo.appendLifecycleStage).toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({ stage: "ingest", status: "failed", error: "boom" }),
    );
  });
});

describe("IngestionService.processDocument 终态回调隔离（回调异常不得影响文档终态写入）", () => {
  it("成功路径：终态监听器抛错时文档保持 ready，不被误改 failed，监听器只被调用一次", async () => {
    const deps = makeDeps();
    deps.docsRepo.findById.mockResolvedValue({ id: "d1", kbId: "kb1", type: "text", blobKey: "x" });
    deps.kbRepo.findById.mockResolvedValue({
      id: "kb1",
      chunkTemplate: "general",
      embeddingModelId: "m1",
    });
    deps.pipeline.run.mockResolvedValue({ chunkCount: 3, parsedText: "hello" });
    const onDocumentTerminal = jest.fn().mockRejectedValue(new Error("切换时 DB 瞬时故障"));

    const svc = makeService(deps, makeModuleRef(onDocumentTerminal));
    await expect(svc.processDocument("d1", 1)).resolves.toBeUndefined();

    expect(deps.docsRepo.update).toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({ status: "ready", chunkVersion: 1 }),
    );
    expect(deps.docsRepo.update).not.toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({ status: "failed" }),
    );
    expect(deps.docsRepo.appendLifecycleStage).not.toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({ status: "failed" }),
    );
    expect(onDocumentTerminal).toHaveBeenCalledTimes(1);
    expect(onDocumentTerminal).toHaveBeenCalledWith("kb1");
  });

  it("失败路径：终态监听器抛错时文档保持 failed + 原始管线错误，监听器只被调用一次", async () => {
    const deps = makeDeps();
    deps.docsRepo.findById.mockResolvedValue({ id: "d1", kbId: "kb1", type: "pdf", blobKey: "x" });
    deps.kbRepo.findById.mockResolvedValue({
      id: "kb1",
      chunkTemplate: "general",
      embeddingModelId: "m1",
    });
    deps.pipeline.run.mockRejectedValue(new Error("解析失败：扫描件"));
    const onDocumentTerminal = jest.fn().mockRejectedValue(new Error("监听器崩了"));

    const svc = makeService(deps, makeModuleRef(onDocumentTerminal));
    await expect(svc.processDocument("d1", 1)).resolves.toBeUndefined();

    expect(deps.docsRepo.update).toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({ status: "failed", error: "解析失败：扫描件" }),
    );
    expect(deps.docsRepo.update).not.toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({ error: "监听器崩了" }),
    );
    expect(onDocumentTerminal).toHaveBeenCalledTimes(1);
    expect(onDocumentTerminal).toHaveBeenCalledWith("kb1");
  });

  it("成功/失败两路径都触发一次终态回调（正常监听器）", async () => {
    const deps = makeDeps();
    deps.docsRepo.findById.mockResolvedValue({ id: "d1", kbId: "kb1", type: "text", blobKey: "x" });
    deps.kbRepo.findById.mockResolvedValue({
      id: "kb1",
      chunkTemplate: "general",
      embeddingModelId: "m1",
    });
    deps.pipeline.run.mockResolvedValue({ chunkCount: 3, parsedText: "hello" });
    const onDocumentTerminal = jest.fn().mockResolvedValue(undefined);

    const svc = makeService(deps, makeModuleRef(onDocumentTerminal));
    await svc.processDocument("d1", 1);
    expect(onDocumentTerminal).toHaveBeenCalledTimes(1);

    deps.pipeline.run.mockRejectedValue(new Error("boom"));
    await svc.processDocument("d1", 1);
    expect(onDocumentTerminal).toHaveBeenCalledTimes(2);
    expect(onDocumentTerminal).toHaveBeenNthCalledWith(2, "kb1");
  });

  it("token 未注册（moduleRef.get 抛错）时静默降级，不影响文档终态", async () => {
    const deps = makeDeps();
    deps.docsRepo.findById.mockResolvedValue({ id: "d1", kbId: "kb1", type: "text", blobKey: "x" });
    deps.kbRepo.findById.mockResolvedValue({
      id: "kb1",
      chunkTemplate: "general",
      embeddingModelId: "m1",
    });
    deps.pipeline.run.mockResolvedValue({ chunkCount: 3, parsedText: "hello" });
    const moduleRef = {
      get: jest.fn(() => {
        throw new Error("Nest could not find DOCUMENT_TERMINAL_LISTENER");
      }),
    } as unknown as ModuleRef;

    const svc = makeService(deps, moduleRef);
    await expect(svc.processDocument("d1", 1)).resolves.toBeUndefined();
    expect(deps.docsRepo.update).toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({ status: "ready" }),
    );
    expect(deps.docsRepo.update).not.toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({ status: "failed" }),
    );
  });
});

// M4.1 新 Run 编排路径。
const DOC_PDF = {
  id: "d1",
  kbId: "kb1",
  type: "pdf",
  name: "a.pdf",
  blobKey: "kb/kb1/d1/original.pdf",
  profileOverrideId: null,
  profileOverrideVersion: null,
};
const KB_GENERAL = {
  id: "kb1",
  name: "KB",
  chunkTemplate: "general",
  defaultProfileId: null,
  defaultProfileVersion: null,
  embeddingModelId: "m1",
  activeVersion: 1,
  buildingVersion: null,
};

describe("IngestionService.createRun", () => {
  it("文档不存在 → NotFoundException", async () => {
    const deps = makeDeps();
    deps.docsRepo.findById.mockResolvedValue(undefined);
    await expect(makeService(deps).createRun("gone")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("snapshot 冻结（AC4）：建 Run 后改注册表定义，Run 快照不受影响", async () => {
    const deps = makeDeps();
    deps.docsRepo.findById.mockResolvedValue({ ...DOC_PDF });
    deps.kbRepo.findById.mockResolvedValue({ ...KB_GENERAL });
    const svc = makeService(deps);
    const run = await svc.createRun("d1");
    const def = deps.registry.get("general-v1", 1)!;
    def.label = "被篡改";
    expect((deps.runs.get(run.id)!.profileSnapshot as { label: string }).label).toBe("通用文档");
  });

  it("入队超集 payload {processingRunId,documentId,targetVersion}，singletonKey=runId、retryLimit=1，doc 标 queued", async () => {
    const deps = makeDeps();
    deps.docsRepo.findById.mockResolvedValue({ ...DOC_PDF });
    deps.kbRepo.findById.mockResolvedValue({ ...KB_GENERAL, activeVersion: 3, buildingVersion: null });
    const svc = makeService(deps);
    const run = await svc.createRun("d1");
    expect(deps.queue.publish).toHaveBeenCalledWith(
      "ingest-document",
      { processingRunId: run.id, documentId: "d1", targetVersion: 3 },
      { singletonKey: run.id, retryLimit: 1 },
    );
    expect(deps.docsRepo.update).toHaveBeenCalledWith("d1", { status: "queued" });
  });

  it("targetVersion 取 buildingVersion（重建期）优先于 activeVersion", async () => {
    const deps = makeDeps();
    deps.docsRepo.findById.mockResolvedValue({ ...DOC_PDF });
    deps.kbRepo.findById.mockResolvedValue({ ...KB_GENERAL, activeVersion: 1, buildingVersion: 2 });
    const run = await makeService(deps).createRun("d1");
    expect(deps.runs.get(run.id)!.targetVersion).toBe(2);
  });

  it("并发 409：同文档已有 queued Run 再 createRun → ConflictException，不入队第二条", async () => {
    const deps = makeDeps();
    deps.docsRepo.findById.mockResolvedValue({ ...DOC_PDF });
    deps.kbRepo.findById.mockResolvedValue({ ...KB_GENERAL });
    const svc = makeService(deps);
    await svc.createRun("d1");
    await expect(svc.createRun("d1")).rejects.toBeInstanceOf(ConflictException);
    expect(deps.queue.publish).toHaveBeenCalledTimes(1);
  });

  it("解析优先级：文档 override > KB default", async () => {
    const deps = makeDeps();
    deps.docsRepo.findById.mockResolvedValue({
      ...DOC_PDF,
      profileOverrideId: "faq-v1",
      profileOverrideVersion: 1,
    });
    deps.kbRepo.findById.mockResolvedValue({
      ...KB_GENERAL,
      defaultProfileId: "course-wechat-v1",
      defaultProfileVersion: 1,
    });
    const run = await makeService(deps).createRun("d1");
    expect(deps.runs.get(run.id)!.profileId).toBe("faq-v1");
  });

  it("解析优先级：无 override 用 KB default", async () => {
    const deps = makeDeps();
    deps.docsRepo.findById.mockResolvedValue({ ...DOC_PDF });
    deps.kbRepo.findById.mockResolvedValue({
      ...KB_GENERAL,
      defaultProfileId: "faq-v1",
      defaultProfileVersion: 1,
    });
    const run = await makeService(deps).createRun("d1");
    expect(deps.runs.get(run.id)!.profileId).toBe("faq-v1");
  });

  it("解析优先级：override 与 default 皆空 → chunkTemplate 反查兜底（custom→course-wechat-v1）", async () => {
    const deps = makeDeps();
    deps.docsRepo.findById.mockResolvedValue({ ...DOC_PDF });
    deps.kbRepo.findById.mockResolvedValue({ ...KB_GENERAL, chunkTemplate: "custom" });
    const run = await makeService(deps).createRun("d1");
    expect(deps.runs.get(run.id)!.profileId).toBe("course-wechat-v1");
  });

  it("未注册的 profileId@version → BadRequestException(PROFILE_VERSION_UNAVAILABLE)，不建 Run 不入队", async () => {
    const deps = makeDeps();
    deps.docsRepo.findById.mockResolvedValue({ ...DOC_PDF });
    deps.kbRepo.findById.mockResolvedValue({ ...KB_GENERAL });
    await expect(
      makeService(deps).createRun("d1", { profileRef: { profileId: "ghost", profileVersion: 9 } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(deps.runsRepo.insert).not.toHaveBeenCalled();
    expect(deps.queue.publish).not.toHaveBeenCalled();
  });

  it("doc.type ∉ snapshot.supportedTypes → 400，不建 Run", async () => {
    const deps = makeDeps();
    // 构造仅支持 pdf 的受限 Profile，文档类型为 text → 拒绝。
    deps.registry = new ProfileRegistry([
      { ...structuredClone(PROCESSING_PROFILES[0]), id: "pdf-only", supportedTypes: ["pdf"] },
    ]);
    deps.docsRepo.findById.mockResolvedValue({ ...DOC_PDF, type: "text" });
    deps.kbRepo.findById.mockResolvedValue({ ...KB_GENERAL });
    await expect(
      makeService(deps).createRun("d1", { profileRef: { profileId: "pdf-only", profileVersion: 1 } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(deps.runsRepo.insert).not.toHaveBeenCalled();
  });

  it("显式 profileRef → 建 Run 前写回 documents.profileOverride*（单文档覆盖语义）", async () => {
    const deps = makeDeps();
    deps.docsRepo.findById.mockResolvedValue({ ...DOC_PDF });
    deps.kbRepo.findById.mockResolvedValue({ ...KB_GENERAL });
    await makeService(deps).createRun("d1", {
      profileRef: { profileId: "faq-v1", profileVersion: 1 },
    });
    expect(deps.docsRepo.update).toHaveBeenCalledWith("d1", {
      profileOverrideId: "faq-v1",
      profileOverrideVersion: 1,
    });
  });

  it("retry：复用最近 failed Run 的冻结快照，不重新解析 Profile", async () => {
    const deps = makeDeps();
    deps.docsRepo.findById.mockResolvedValue({ ...DOC_PDF });
    deps.kbRepo.findById.mockResolvedValue({ ...KB_GENERAL });
    deps.runs.set("run-old", {
      id: "run-old",
      documentId: "d1",
      status: "failed",
      createdAt: new Date(Date.now() - 1000),
      profileSnapshot: { ...structuredClone(PROCESSING_PROFILES[0]), label: "旧快照标记" },
      profileId: "general-v1",
      profileVersion: 1,
    });
    const run = await makeService(deps).createRun("d1", { retry: true });
    expect((deps.runs.get(run.id)!.profileSnapshot as { label: string }).label).toBe("旧快照标记");
  });
});

describe("IngestionService.processRun", () => {
  function seedQueuedRun(deps: ReturnType<typeof makeDeps>, over: Row = {}) {
    deps.runs.set("r1", {
      id: "r1",
      documentId: "d1",
      kbId: "kb1",
      targetVersion: 2,
      profileId: "general-v1",
      profileVersion: 1,
      profileSnapshot: structuredClone(PROCESSING_PROFILES[0]),
      status: "queued",
      createdAt: new Date(),
      startedAt: null,
      ...over,
    });
  }

  it("成功路径：run→succeeded（engine/metrics/canonicalBlobKey/endedAt），doc ready+chunkVersion+parsedText=markdown，canonical 写稳定 key", async () => {
    const deps = makeDeps();
    seedQueuedRun(deps);
    deps.docsRepo.findById.mockResolvedValue({ ...DOC_PDF });
    deps.kbRepo.findById.mockResolvedValue({ ...KB_GENERAL });
    deps.pipeline.run.mockResolvedValue(pipelineResult() as never);
    await makeService(deps).processRun("r1");

    expect(deps.runs.get("r1")).toMatchObject({
      status: "succeeded",
      parserEngine: "pdf-parse",
      parserVersion: "2.4.5",
      canonicalBlobKey: "kb/kb1/d1/runs/r1/canonical.json",
      metrics: { pages: 1 },
    });
    expect(deps.runs.get("r1")!.endedAt).toBeInstanceOf(Date);
    expect(deps.blobStore.put).toHaveBeenCalledWith(
      "kb/kb1/d1/runs/r1/canonical.json",
      expect.any(Buffer),
    );
    expect(deps.docsRepo.update).toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({ status: "ready", chunkVersion: 2, parsedText: "md", error: null }),
    );
  });

  it("pipeline 抛 IngestionError → run failed+error，doc failed+error，切片存储未被触碰（pipeline fake 未落库）", async () => {
    const deps = makeDeps();
    seedQueuedRun(deps);
    deps.docsRepo.findById.mockResolvedValue({ ...DOC_PDF });
    deps.kbRepo.findById.mockResolvedValue({ ...KB_GENERAL });
    deps.pipeline.run.mockRejectedValue(new Error("[PARSE_EMPTY] 文档解析结果为空"));
    await makeService(deps).processRun("r1");

    expect(deps.runs.get("r1")).toMatchObject({
      status: "failed",
      error: "[PARSE_EMPTY] 文档解析结果为空",
    });
    expect(deps.docsRepo.update).toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({ status: "failed", error: "[PARSE_EMPTY] 文档解析结果为空" }),
    );
    expect(deps.blobStore.put).not.toHaveBeenCalled();
  });

  it("Run 不存在 → 静默返回（幂等）", async () => {
    const deps = makeDeps();
    await expect(makeService(deps).processRun("nope")).resolves.toBeUndefined();
    expect(deps.pipeline.run).not.toHaveBeenCalled();
  });

  it("文档已删除 → Run 标 failed（文档已删除），不跑管线", async () => {
    const deps = makeDeps();
    seedQueuedRun(deps);
    deps.docsRepo.findById.mockResolvedValue(undefined);
    await makeService(deps).processRun("r1");
    expect(deps.runs.get("r1")).toMatchObject({ status: "failed", error: "文档已删除" });
    expect(deps.pipeline.run).not.toHaveBeenCalled();
  });

  it("重复投递幂等 + 僵尸兜底：succeeded 跳过；running<15min 跳过；running≥15min 重跑", async () => {
    const deps = makeDeps();
    deps.docsRepo.findById.mockResolvedValue({ ...DOC_PDF });
    deps.kbRepo.findById.mockResolvedValue({ ...KB_GENERAL });
    deps.pipeline.run.mockResolvedValue(pipelineResult() as never);
    const base = {
      documentId: "d1",
      kbId: "kb1",
      targetVersion: 2,
      profileId: "general-v1",
      profileVersion: 1,
      profileSnapshot: structuredClone(PROCESSING_PROFILES[0]),
      createdAt: new Date(),
    };
    deps.runs.set("r-done", { id: "r-done", ...base, status: "succeeded" });
    deps.runs.set("r-fresh", { id: "r-fresh", ...base, status: "running", startedAt: new Date() });
    deps.runs.set("r-zombie", {
      id: "r-zombie",
      ...base,
      status: "running",
      startedAt: new Date(Date.now() - 16 * 60 * 1000),
    });
    const svc = makeService(deps);
    await svc.processRun("r-done");
    await svc.processRun("r-fresh");
    expect(deps.pipeline.run).not.toHaveBeenCalled();
    await svc.processRun("r-zombie");
    expect(deps.pipeline.run).toHaveBeenCalledTimes(1);
  });

  it("成功与失败路径都恰好回调一次 notifyDocumentTerminal（蓝绿协议不回归）", async () => {
    const deps = makeDeps();
    deps.docsRepo.findById.mockResolvedValue({ ...DOC_PDF });
    deps.kbRepo.findById.mockResolvedValue({ ...KB_GENERAL });
    const onDocumentTerminal = jest.fn().mockResolvedValue(undefined);
    const svc = makeService(deps, makeModuleRef(onDocumentTerminal));

    deps.runs.set("r-ok", {
      id: "r-ok",
      documentId: "d1",
      kbId: "kb1",
      targetVersion: 2,
      profileSnapshot: structuredClone(PROCESSING_PROFILES[0]),
      status: "queued",
      createdAt: new Date(),
      startedAt: null,
    });
    deps.pipeline.run.mockResolvedValue(pipelineResult() as never);
    await svc.processRun("r-ok");
    expect(onDocumentTerminal).toHaveBeenCalledTimes(1);
    expect(onDocumentTerminal).toHaveBeenCalledWith("kb1");

    deps.runs.set("r-bad", {
      id: "r-bad",
      documentId: "d1",
      kbId: "kb1",
      targetVersion: 2,
      profileSnapshot: structuredClone(PROCESSING_PROFILES[0]),
      status: "queued",
      createdAt: new Date(),
      startedAt: null,
    });
    deps.pipeline.run.mockRejectedValue(new Error("boom"));
    await svc.processRun("r-bad");
    expect(onDocumentTerminal).toHaveBeenCalledTimes(2);
  });
});

// —— B1/F4：gold 过期广播挂在**解析完成态**（review P3：原实现在入队时就广播）——

describe("IngestionService 的 gold 过期广播时机", () => {
  function readyDeps() {
    const deps = makeDeps();
    deps.docsRepo.findById.mockResolvedValue({
      id: "d1",
      kbId: "kb1",
      type: "text",
      blobKey: "kb/kb1/d1/original.txt",
    });
    deps.kbRepo.findById.mockResolvedValue({
      id: "kb1",
      chunkTemplate: "general",
      embeddingModelId: "m1",
    });
    return deps;
  }

  /**
   * 【时机不变量】切片内容真的换掉（ready）之后才广播——spec §4.2 逐字「二者完成后需通知 eval 域」。
   * 入队时广播会留下这个窗口：用户在解析期间点「确认仍有效」清掉标志，解析随后完成、
   * 内容真换了，而不会再有第二次广播 ⇒ 该用例从此静默失去过期提示。
   */
  it("processDocument 走到 ready → 广播一次，带上 docId", async () => {
    const deps = readyDeps();
    deps.pipeline.run.mockResolvedValue({ chunkCount: 3, parsedText: "hello" });
    const changes = new DocumentChangeNotifier();
    const seen: string[] = [];
    changes.register(async (docId) => {
      seen.push(docId);
    });

    await makeService(deps, undefined, changes).processDocument("d1", 1);
    expect(seen).toEqual(["d1"]);
  });

  /** 解析失败时旧切片原封不动（chunkVersion 未前移）⇒ 内容没变，不该报过期。 */
  it("processDocument 落 failed → 不广播", async () => {
    const deps = readyDeps();
    deps.pipeline.run.mockRejectedValue(new Error("boom"));
    const changes = new DocumentChangeNotifier();
    const seen: string[] = [];
    changes.register(async (docId) => {
      seen.push(docId);
    });

    await makeService(deps, undefined, changes).processDocument("d1", 1);
    expect(seen).toEqual([]);
  });

  it("processRun 走到 ready → 广播一次；失败则不广播", async () => {
    const deps = readyDeps();
    const changes = new DocumentChangeNotifier();
    const seen: string[] = [];
    changes.register(async (docId) => {
      seen.push(docId);
    });
    const svc = makeService(deps, undefined, changes);

    deps.runs.set("r-ok", {
      id: "r-ok",
      documentId: "d1",
      kbId: "kb1",
      targetVersion: 2,
      profileSnapshot: structuredClone(PROCESSING_PROFILES[0]),
      status: "queued",
      createdAt: new Date(),
      startedAt: null,
    });
    deps.pipeline.run.mockResolvedValue(pipelineResult() as never);
    await svc.processRun("r-ok");
    expect(seen).toEqual(["d1"]);

    deps.runs.set("r-bad", {
      id: "r-bad",
      documentId: "d1",
      kbId: "kb1",
      targetVersion: 2,
      profileSnapshot: structuredClone(PROCESSING_PROFILES[0]),
      status: "queued",
      createdAt: new Date(),
      startedAt: null,
    });
    deps.pipeline.run.mockRejectedValue(new Error("boom"));
    await svc.processRun("r-bad");
    expect(seen).toEqual(["d1"]); // 未新增
  });

  /**
   * 【fail-open 不变量】评测集标不上「可能过期」是体验问题；
   * 因为它把一次已经落地的文档终态打回失败，是事故。监听方抛错绝不能冒泡。
   */
  it("监听方抛错不影响文档终态写入", async () => {
    const deps = readyDeps();
    deps.pipeline.run.mockResolvedValue({ chunkCount: 3, parsedText: "hello" });
    const changes = new DocumentChangeNotifier();
    changes.register(async () => {
      throw new Error("eval domain down");
    });

    await expect(
      makeService(deps, undefined, changes).processDocument("d1", 1),
    ).resolves.toBeUndefined();
    expect(deps.docsRepo.update).toHaveBeenCalledWith("d1", expect.objectContaining({ status: "ready" }));
  });

  /** 未注入广播点（单测里直接 new、或未来某个局部模块图）时静默跳过，不炸主流程。 */
  it("未注入 DocumentChangeNotifier 时不报错", async () => {
    const deps = readyDeps();
    deps.pipeline.run.mockResolvedValue({ chunkCount: 3, parsedText: "hello" });
    await expect(makeService(deps).processDocument("d1", 1)).resolves.toBeUndefined();
  });
});
