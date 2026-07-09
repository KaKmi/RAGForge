import { NotFoundException } from "@nestjs/common";
import { ChunksService } from "../src/modules/chunks/chunks.service";
import type { ChunksRepository } from "../src/modules/chunks/chunks.repository";
import type { DocumentsRepository } from "../src/modules/documents/documents.repository";

describe("ChunksService.listPage", () => {
  it("按文档当前 chunkVersion 查询（非 kb.activeVersion）", async () => {
    const docsRepo = { findById: jest.fn(async () => ({ id: "d1", chunkVersion: 3 })) };
    const chunksRepo = {
      findPage: jest.fn(async () => ({ items: [], total: 0 })),
      batchDelete: jest.fn(),
    };
    const svc = new ChunksService(
      chunksRepo as unknown as ChunksRepository,
      docsRepo as unknown as DocumentsRepository,
    );
    await svc.listPage("d1", { offset: 0, limit: 20 });
    expect(chunksRepo.findPage).toHaveBeenCalledWith("d1", 3, { offset: 0, limit: 20, q: undefined });
  });

  it("按查询关键字透传给 repository", async () => {
    const docsRepo = { findById: jest.fn(async () => ({ id: "d1", chunkVersion: 2 })) };
    const chunksRepo = {
      findPage: jest.fn(async () => ({ items: [], total: 0 })),
      batchDelete: jest.fn(),
    };
    const svc = new ChunksService(
      chunksRepo as unknown as ChunksRepository,
      docsRepo as unknown as DocumentsRepository,
    );
    await svc.listPage("d1", { offset: 10, limit: 5, q: "退货" });
    expect(chunksRepo.findPage).toHaveBeenCalledWith("d1", 2, { offset: 10, limit: 5, q: "退货" });
  });

  it("返回的分页信息映射 chunk 字段并计算 hasMore", async () => {
    const docsRepo = { findById: jest.fn(async () => ({ id: "d1", chunkVersion: 1 })) };
    const row = {
      id: "c1",
      docId: "d1",
      kbId: "kb1",
      version: 1,
      seq: 0,
      text: "文本",
      tokenCount: 10,
      section: "章节",
      embedding: [0.1],
    };
    const chunksRepo = {
      findPage: jest.fn(async () => ({ items: [row], total: 5 })),
      batchDelete: jest.fn(),
    };
    const svc = new ChunksService(
      chunksRepo as unknown as ChunksRepository,
      docsRepo as unknown as DocumentsRepository,
    );
    const page = await svc.listPage("d1", { offset: 0, limit: 1 });
    expect(page).toEqual({
      items: [
        {
          id: "c1",
          docId: "d1",
          kbId: "kb1",
          version: 1,
          seq: 0,
          text: "文本",
          tokenCount: 10,
          section: "章节",
        },
      ],
      total: 5,
      offset: 0,
      limit: 1,
      hasMore: true,
    });
  });

  it("文档尚无 chunkVersion（未入库完成）时返回空页而非报错", async () => {
    const docsRepo = { findById: jest.fn(async () => ({ id: "d1", chunkVersion: null })) };
    const chunksRepo = { findPage: jest.fn(), batchDelete: jest.fn() };
    const svc = new ChunksService(
      chunksRepo as unknown as ChunksRepository,
      docsRepo as unknown as DocumentsRepository,
    );
    const page = await svc.listPage("d1", { offset: 0, limit: 20 });
    expect(page).toEqual({ items: [], total: 0, offset: 0, limit: 20, hasMore: false });
    expect(chunksRepo.findPage).not.toHaveBeenCalled();
  });

  it("文档不存在抛 404", async () => {
    const docsRepo = { findById: jest.fn(async () => undefined) };
    const svc = new ChunksService(
      { findPage: jest.fn(), batchDelete: jest.fn() } as unknown as ChunksRepository,
      docsRepo as unknown as DocumentsRepository,
    );
    await expect(svc.listPage("gone", { offset: 0, limit: 20 })).rejects.toThrow(NotFoundException);
  });
});

describe("ChunksService.batchDelete", () => {
  it("透传 ids 给 repository.batchDelete 并回传删除数量", async () => {
    const chunksRepo = { findPage: jest.fn(), batchDelete: jest.fn(async () => 2) };
    const svc = new ChunksService(
      chunksRepo as unknown as ChunksRepository,
      { findById: jest.fn() } as unknown as DocumentsRepository,
    );
    const result = await svc.batchDelete(["c1", "c2"]);
    expect(chunksRepo.batchDelete).toHaveBeenCalledWith(["c1", "c2"]);
    expect(result).toEqual({ deletedCount: 2 });
  });
});
