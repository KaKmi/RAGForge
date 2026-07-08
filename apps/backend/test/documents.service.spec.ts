import { BadRequestException, NotFoundException } from "@nestjs/common";
import { DocumentsService } from "../src/modules/documents/documents.service";
import type { DocumentsRepository } from "../src/modules/documents/documents.repository";
import type { KnowledgeBasesRepository } from "../src/modules/knowledge-bases/knowledge-bases.repository";
import type { BlobStore } from "../src/platform/storage/blob-store.port";
import type { IngestionService } from "../src/modules/ingestion/ingestion.service";

function makeDeps() {
  const repo = {
    findByKb: jest.fn(async () => []),
    findById: jest.fn(),
    insert: jest.fn(async (row: object) => ({
      id: "d1",
      status: "pending",
      metadata: {},
      lifecycle: [],
      chunkVersion: null,
      uploadedAt: new Date(),
      updatedAt: new Date(),
      ...row,
    })),
    update: jest.fn(async (id: string, patch: object) => ({ id, ...patch })),
    appendLifecycleStage: jest.fn(),
    delete: jest.fn(),
  };
  const kbRepo = { findById: jest.fn(async () => ({ id: "kb1", activeVersion: 1, buildingVersion: null })) };
  const blobStore: jest.Mocked<BlobStore> = {
    put: jest.fn(),
    get: jest.fn(async () => Buffer.from("x")),
    delete: jest.fn(),
  };
  const ingestion = { enqueue: jest.fn() };
  return { repo, kbRepo, blobStore, ingestion };
}

function makeService(deps: ReturnType<typeof makeDeps>): DocumentsService {
  return new DocumentsService(
    deps.repo as unknown as DocumentsRepository,
    deps.kbRepo as unknown as KnowledgeBasesRepository,
    deps.blobStore,
    deps.ingestion as unknown as IngestionService,
  );
}

describe("DocumentsService.upload", () => {
  it("autoParse=true：建档 status=pending 后立即 enqueue（目标版本取 kb.buildingVersion ?? activeVersion）", async () => {
    const deps = makeDeps();
    const svc = makeService(deps);
    const files = [{ originalname: "a.pdf", buffer: Buffer.from("x"), size: 3, mimetype: "application/pdf" }];
    const docs = await svc.upload("kb1", files as never, { autoParse: true });
    expect(deps.blobStore.put).toHaveBeenCalledWith(
      expect.stringMatching(/^kb\/kb1\/.+\/original\.pdf$/),
      expect.any(Buffer),
    );
    expect(deps.ingestion.enqueue).toHaveBeenCalledWith("d1", 1);
    expect(docs[0].id).toBe("d1");
  });

  it("目标版本取 kb.buildingVersion（重建中优先写入 building 版本，而非 active）", async () => {
    const deps = makeDeps();
    deps.kbRepo.findById.mockResolvedValue({ id: "kb1", activeVersion: 1, buildingVersion: 2 });
    const svc = makeService(deps);
    const files = [{ originalname: "a.pdf", buffer: Buffer.from("x"), size: 3, mimetype: "application/pdf" }];
    await svc.upload("kb1", files as never, { autoParse: true });
    expect(deps.ingestion.enqueue).toHaveBeenCalledWith("d1", 2);
  });

  it("autoParse=false：建档但不 enqueue，状态停在 pending", async () => {
    const deps = makeDeps();
    const svc = makeService(deps);
    const files = [{ originalname: "b.md", buffer: Buffer.from("# x"), size: 3, mimetype: "text/markdown" }];
    await svc.upload("kb1", files as never, { autoParse: false });
    expect(deps.ingestion.enqueue).not.toHaveBeenCalled();
  });

  it("blob key 由服务端生成，不接受客户端路径片段进入文件系统操作（relativePath 仅存 metadata 展示）", async () => {
    const deps = makeDeps();
    const svc = makeService(deps);
    const files = [
      { originalname: "../../etc/passwd.txt", buffer: Buffer.from("x"), size: 1, mimetype: "text/plain" },
    ];
    await svc.upload("kb1", files as never, { autoParse: false });
    const [key] = deps.blobStore.put.mock.calls[0];
    expect(key).not.toContain("..");
    expect(key).toMatch(/^kb\/kb1\/[^/]+\/original\.text$/);
  });

  it("多文件批量上传：每个文件各自建档 + 各自 put blob", async () => {
    const deps = makeDeps();
    const svc = makeService(deps);
    const files = [
      { originalname: "a.pdf", buffer: Buffer.from("x"), size: 1, mimetype: "application/pdf" },
      { originalname: "b.docx", buffer: Buffer.from("y"), size: 1, mimetype: "application/msword" },
    ];
    const docs = await svc.upload("kb1", files as never, { autoParse: false });
    expect(deps.blobStore.put).toHaveBeenCalledTimes(2);
    expect(docs).toHaveLength(2);
  });

  it("kb 不存在时抛 404，不落盘、不建档", async () => {
    const deps = makeDeps();
    deps.kbRepo.findById.mockResolvedValue(undefined);
    const svc = makeService(deps);
    const files = [{ originalname: "a.pdf", buffer: Buffer.from("x"), size: 1, mimetype: "application/pdf" }];
    await expect(svc.upload("gone", files as never, { autoParse: false })).rejects.toThrow(
      NotFoundException,
    );
    expect(deps.blobStore.put).not.toHaveBeenCalled();
    expect(deps.repo.insert).not.toHaveBeenCalled();
  });

  it("不支持的文件类型（扩展名不在白名单）拒绝：抛 400，不落盘、不建档", async () => {
    const deps = makeDeps();
    const svc = makeService(deps);
    const files = [{ originalname: "virus.exe", buffer: Buffer.from("x"), size: 1, mimetype: "application/octet-stream" }];
    await expect(svc.upload("kb1", files as never, { autoParse: false })).rejects.toThrow(
      BadRequestException,
    );
    expect(deps.blobStore.put).not.toHaveBeenCalled();
    expect(deps.repo.insert).not.toHaveBeenCalled();
  });
});

describe("DocumentsService.triggerParse", () => {
  it("手动/重试 parse：读取文档所属 kb 目标版本后 enqueue", async () => {
    const deps = makeDeps();
    deps.repo.findById.mockResolvedValue({
      id: "d1",
      kbId: "kb1",
      status: "failed",
      metadata: {},
      lifecycle: [],
      chunkVersion: null,
      uploadedAt: new Date(),
      updatedAt: new Date(),
    });
    const svc = makeService(deps);
    await svc.triggerParse("d1");
    expect(deps.ingestion.enqueue).toHaveBeenCalledWith("d1", 1);
  });

  it("文档不存在抛 404", async () => {
    const deps = makeDeps();
    deps.repo.findById.mockResolvedValue(undefined);
    const svc = makeService(deps);
    await expect(svc.triggerParse("gone")).rejects.toThrow(NotFoundException);
  });
});

describe("DocumentsService.updateMetadata", () => {
  it("更新元数据并返回最新文档", async () => {
    const deps = makeDeps();
    deps.repo.findById.mockResolvedValue({
      id: "d1",
      kbId: "kb1",
      name: "a.pdf",
      type: "pdf",
      size: 1,
      status: "ready",
      metadata: {},
      lifecycle: [],
      chunkVersion: 1,
      uploadedAt: new Date(),
      updatedAt: new Date(),
    });
    deps.repo.update.mockResolvedValue({
      id: "d1",
      kbId: "kb1",
      name: "a.pdf",
      type: "pdf",
      size: 1,
      status: "ready",
      metadata: { k: "v" },
      lifecycle: [],
      chunkVersion: 1,
      uploadedAt: new Date(),
      updatedAt: new Date(),
    });
    const svc = makeService(deps);
    const doc = await svc.updateMetadata("d1", { metadata: { k: "v" } });
    expect(deps.repo.update).toHaveBeenCalledWith("d1", { metadata: { k: "v" } });
    expect(doc.metadata).toEqual({ k: "v" });
  });

  it("文档不存在抛 404", async () => {
    const deps = makeDeps();
    deps.repo.findById.mockResolvedValue(undefined);
    const svc = makeService(deps);
    await expect(svc.updateMetadata("gone", { metadata: {} })).rejects.toThrow(NotFoundException);
  });
});

describe("DocumentsService.remove", () => {
  it("级联删除 blob 与 DB 行；blob 删除失败不阻塞 DB 删除", async () => {
    const deps = makeDeps();
    deps.repo.findById.mockResolvedValue({ id: "d1", blobKey: "kb/kb1/d1/original.pdf" });
    deps.blobStore.delete.mockRejectedValueOnce(new Error("fs error"));
    const svc = makeService(deps);
    await svc.remove("d1");
    expect(deps.blobStore.delete).toHaveBeenCalledWith("kb/kb1/d1/original.pdf");
    expect(deps.repo.delete).toHaveBeenCalledWith("d1");
  });

  it("文档不存在抛 404", async () => {
    const deps = makeDeps();
    deps.repo.findById.mockResolvedValue(undefined);
    const svc = makeService(deps);
    await expect(svc.remove("gone")).rejects.toThrow(NotFoundException);
  });
});
