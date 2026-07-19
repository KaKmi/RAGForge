import { BadRequestException, NotFoundException } from "@nestjs/common";
import { DocumentsService } from "../src/modules/documents/documents.service";
import type { DocumentsRepository } from "../src/modules/documents/documents.repository";
import type { KnowledgeBasesRepository } from "../src/modules/knowledge-bases/knowledge-bases.repository";
import type { ChunksRepository } from "../src/modules/chunks/chunks.repository";
import type { BlobStore } from "../src/platform/storage/blob-store.port";
import type { IngestionService } from "../src/modules/ingestion/ingestion.service";
import { ProcessingRunsRepository } from "../src/modules/ingestion/processing-runs.repository";
import {
  PROCESSING_PROFILES,
  ProfileRegistry,
} from "../src/modules/ingestion/profiles/profile-registry";
import type { AppConfigService } from "../src/platform/config/config.service";
import { DocumentChangeNotifier } from "../src/platform/events/document-change.notifier";

// 合法 magic bytes 的测试文件头（pdf=%PDF-、docx=PK zip）；markdown/text 任意文本。
const PDF_BYTES = Buffer.from("%PDF-1.4\n%test");
const DOCX_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);

function makeDeps(processingProfilesEnabled = false) {
  const repo = {
    findByKb: jest.fn(async () => []),
    findById: jest.fn(),
    insert: jest.fn(async (row: object) => ({
      id: "d1",
      status: "pending",
      metadata: {},
      lifecycle: [],
      chunkVersion: null,
      profileOverrideId: null,
      profileOverrideVersion: null,
      uploadedAt: new Date(),
      updatedAt: new Date(),
      ...row,
    })),
    update: jest.fn(async (id: string, patch: object) => ({ id, ...patch })),
    appendLifecycleStage: jest.fn(),
    delete: jest.fn(),
  };
  const kbRepo = {
    findById: jest.fn(async () => ({ id: "kb1", activeVersion: 1, buildingVersion: null })),
  };
  const blobStore: jest.Mocked<BlobStore> = {
    put: jest.fn(),
    get: jest.fn(async () => Buffer.from("x")),
    delete: jest.fn(),
  };
  const ingestion = { enqueue: jest.fn(), createRun: jest.fn() };
  const chunksRepo = {
    countByDocs: jest.fn(
      async () => [] as Array<{ docId: string; version: number; count: number }>,
    ),
  };
  const runsRepo = { findByDocument: jest.fn(async () => [] as unknown[]) };
  const registry = new ProfileRegistry(structuredClone(PROCESSING_PROFILES));
  // 默认 flag=false（legacy enqueue 路径）；flag=true 的 createRun 分流由专门用例覆盖。
  const config = { processingProfilesEnabled } as unknown as AppConfigService;
  // B1/F4：文档变更广播点（平台层，@Global）。真实实现——fail-open 语义正是被测对象之一。
  const changes = new DocumentChangeNotifier();
  return { repo, kbRepo, blobStore, ingestion, chunksRepo, runsRepo, registry, config, changes };
}

function makeService(deps: ReturnType<typeof makeDeps>): DocumentsService {
  return new DocumentsService(
    deps.repo as unknown as DocumentsRepository,
    deps.kbRepo as unknown as KnowledgeBasesRepository,
    deps.chunksRepo as unknown as ChunksRepository,
    deps.blobStore,
    deps.ingestion as unknown as IngestionService,
    deps.config,
    deps.runsRepo as unknown as ProcessingRunsRepository,
    deps.registry,
    deps.changes,
  );
}

describe("DocumentsService.upload", () => {
  it("autoParse=true：建档 status=pending 后立即 enqueue（目标版本取 kb.buildingVersion ?? activeVersion）", async () => {
    const deps = makeDeps();
    const svc = makeService(deps);
    const files = [
      { originalname: "a.pdf", buffer: PDF_BYTES, size: 3, mimetype: "application/pdf" },
    ];
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
    const files = [
      { originalname: "a.pdf", buffer: PDF_BYTES, size: 3, mimetype: "application/pdf" },
    ];
    await svc.upload("kb1", files as never, { autoParse: true });
    expect(deps.ingestion.enqueue).toHaveBeenCalledWith("d1", 2);
  });

  it("autoParse=false：建档但不 enqueue，状态停在 pending", async () => {
    const deps = makeDeps();
    const svc = makeService(deps);
    const files = [
      { originalname: "b.md", buffer: Buffer.from("# x"), size: 3, mimetype: "text/markdown" },
    ];
    await svc.upload("kb1", files as never, { autoParse: false });
    expect(deps.ingestion.enqueue).not.toHaveBeenCalled();
  });

  it("blob key 由服务端生成，不接受客户端路径片段进入文件系统操作（relativePath 仅存 metadata 展示）", async () => {
    const deps = makeDeps();
    const svc = makeService(deps);
    const files = [
      {
        originalname: "../../etc/passwd.txt",
        buffer: Buffer.from("x"),
        size: 1,
        mimetype: "text/plain",
      },
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
      { originalname: "a.pdf", buffer: PDF_BYTES, size: 1, mimetype: "application/pdf" },
      { originalname: "b.docx", buffer: DOCX_BYTES, size: 1, mimetype: "application/msword" },
    ];
    const docs = await svc.upload("kb1", files as never, { autoParse: false });
    expect(deps.blobStore.put).toHaveBeenCalledTimes(2);
    expect(docs).toHaveLength(2);
  });

  it("kb 不存在时抛 404，不落盘、不建档", async () => {
    const deps = makeDeps();
    deps.kbRepo.findById.mockResolvedValue(undefined);
    const svc = makeService(deps);
    const files = [
      { originalname: "a.pdf", buffer: PDF_BYTES, size: 1, mimetype: "application/pdf" },
    ];
    await expect(svc.upload("gone", files as never, { autoParse: false })).rejects.toThrow(
      NotFoundException,
    );
    expect(deps.blobStore.put).not.toHaveBeenCalled();
    expect(deps.repo.insert).not.toHaveBeenCalled();
  });

  it("混合批次（合法+非法类型）整批拒绝：抛 400 且零副作用——不落盘、不建档、不入队", async () => {
    const deps = makeDeps();
    const svc = makeService(deps);
    const files = [
      { originalname: "good.pdf", buffer: PDF_BYTES, size: 1, mimetype: "application/pdf" },
      {
        originalname: "bad.exe",
        buffer: Buffer.from("x"),
        size: 1,
        mimetype: "application/octet-stream",
      },
    ];
    await expect(svc.upload("kb1", files as never, { autoParse: true })).rejects.toThrow(
      BadRequestException,
    );
    expect(deps.blobStore.put).not.toHaveBeenCalled();
    expect(deps.repo.insert).not.toHaveBeenCalled();
    expect(deps.ingestion.enqueue).not.toHaveBeenCalled();
  });

  it("不支持的文件类型（扩展名不在白名单）拒绝：抛 400，不落盘、不建档", async () => {
    const deps = makeDeps();
    const svc = makeService(deps);
    const files = [
      {
        originalname: "virus.exe",
        buffer: Buffer.from("x"),
        size: 1,
        mimetype: "application/octet-stream",
      },
    ];
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

describe("DocumentsService 文件名编码与切片计数（QA 回归）", () => {
  it("multipart 文件名被 busboy 按 latin1 误解码时还原 UTF-8 中文；纯 ASCII 不受影响", async () => {
    const deps = makeDeps();
    const svc = makeService(deps);
    const utf8Name = "13问 车险知识 AI客服.md";
    const mojibake = Buffer.from(utf8Name, "utf8").toString("latin1"); // busboy 实际交付的形态
    const docs = await svc.upload(
      "kb1",
      [
        { originalname: mojibake, buffer: Buffer.from("x"), size: 1, mimetype: "text/markdown" },
        { originalname: "plain.txt", buffer: Buffer.from("y"), size: 1, mimetype: "text/plain" },
      ] as never,
      { autoParse: false },
    );
    expect(deps.repo.insert).toHaveBeenCalledWith(expect.objectContaining({ name: utf8Name }));
    expect(deps.repo.insert).toHaveBeenCalledWith(expect.objectContaining({ name: "plain.txt" }));
    expect(docs).toHaveLength(2);
  });

  it("list 按各文档自己的 chunkVersion 填充 chunksCount；未解析文档恒为 0", async () => {
    const deps = makeDeps();
    const now = new Date();
    deps.repo.findByKb.mockResolvedValue([
      {
        id: "d1",
        kbId: "kb1",
        name: "a.md",
        type: "markdown",
        size: 1,
        blobKey: "k1",
        parsedText: "t",
        metadata: {},
        status: "ready",
        chunkVersion: 2,
        lifecycle: [],
        error: null,
        uploadedAt: now,
        updatedAt: now,
      },
      {
        id: "d2",
        kbId: "kb1",
        name: "b.md",
        type: "markdown",
        size: 1,
        blobKey: "k2",
        parsedText: null,
        metadata: {},
        status: "pending",
        chunkVersion: null,
        lifecycle: [],
        error: null,
        uploadedAt: now,
        updatedAt: now,
      },
    ] as never);
    deps.chunksRepo.countByDocs.mockResolvedValue([
      { docId: "d1", version: 1, count: 99 }, // 旧版本残留，不得被计入
      { docId: "d1", version: 2, count: 7 },
    ]);
    const svc = makeService(deps);
    const docs = await svc.list("kb1");
    expect(deps.chunksRepo.countByDocs).toHaveBeenCalledWith(["d1"]); // 未解析的 d2 不参与查询
    expect(docs.find((d) => d.id === "d1")?.chunksCount).toBe(7);
    expect(docs.find((d) => d.id === "d2")?.chunksCount).toBe(0);
  });
});

describe("DocumentsService M4.1 Profile 覆盖 / magic bytes / Run 历史", () => {
  it("upload 带合法 profile 覆盖 → 每个文档行写 profileOverride*，autoParse 经 createRun 入队", async () => {
    const deps = makeDeps(true); // flag=true → createRun 分流
    const svc = makeService(deps);
    const files = [{ originalname: "a.pdf", buffer: PDF_BYTES, size: 1, mimetype: "application/pdf" }];
    await svc.upload("kb1", files as never, { autoParse: true, profileId: "faq-v1", profileVersion: 1 });
    expect(deps.repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ profileOverrideId: "faq-v1", profileOverrideVersion: 1 }),
    );
    expect(deps.ingestion.createRun).toHaveBeenCalledWith("d1");
    expect(deps.ingestion.enqueue).not.toHaveBeenCalled();
  });

  it("upload 带未注册 profile → 400，整批无副作用", async () => {
    const deps = makeDeps();
    const svc = makeService(deps);
    const files = [{ originalname: "a.pdf", buffer: PDF_BYTES, size: 1, mimetype: "application/pdf" }];
    await expect(
      svc.upload("kb1", files as never, { autoParse: true, profileId: "ghost", profileVersion: 9 }),
    ).rejects.toThrow(BadRequestException);
    expect(deps.blobStore.put).not.toHaveBeenCalled();
    expect(deps.repo.insert).not.toHaveBeenCalled();
  });

  it("upload 半个 profile ref（只有 profileId）→ 400", async () => {
    const deps = makeDeps();
    const svc = makeService(deps);
    const files = [{ originalname: "a.pdf", buffer: PDF_BYTES, size: 1, mimetype: "application/pdf" }];
    await expect(
      svc.upload("kb1", files as never, { autoParse: false, profileId: "faq-v1" }),
    ).rejects.toThrow(BadRequestException);
    expect(deps.repo.insert).not.toHaveBeenCalled();
  });

  it("magic bytes：.pdf 非 %PDF- 开头 → 400 整批拒绝", async () => {
    const deps = makeDeps();
    const svc = makeService(deps);
    const files = [
      { originalname: "fake.pdf", buffer: Buffer.from("<html>"), size: 6, mimetype: "application/pdf" },
    ];
    await expect(svc.upload("kb1", files as never, { autoParse: false })).rejects.toThrow(
      BadRequestException,
    );
    expect(deps.repo.insert).not.toHaveBeenCalled();
  });

  it("magic bytes：.docx 非 PK 头 → 400；.md/.txt 不查（任意文本合法）", async () => {
    const deps = makeDeps();
    const svc = makeService(deps);
    await expect(
      svc.upload(
        "kb1",
        [{ originalname: "fake.docx", buffer: Buffer.from("not zip"), size: 7, mimetype: "application/msword" }] as never,
        { autoParse: false },
      ),
    ).rejects.toThrow(BadRequestException);
    // markdown/text 任意内容放行
    const ok = await svc.upload(
      "kb1",
      [{ originalname: "n.md", buffer: Buffer.from("anything"), size: 8, mimetype: "text/markdown" }] as never,
      { autoParse: false },
    );
    expect(ok).toHaveLength(1);
  });

  it("triggerParse（flag=true）空 body → createRun 无 profileRef/retry", async () => {
    const deps = makeDeps(true);
    deps.repo.findById.mockResolvedValue({ id: "d1", kbId: "kb1", status: "ready", metadata: {}, lifecycle: [], chunkVersion: 1, uploadedAt: new Date(), updatedAt: new Date() });
    await makeService(deps).triggerParse("d1", {});
    expect(deps.ingestion.createRun).toHaveBeenCalledWith("d1", { retry: false, profileRef: undefined });
  });

  it("triggerParse（flag=true）带 ref → opts.profileRef；mode:'retry' → opts.retry=true", async () => {
    const deps = makeDeps(true);
    deps.repo.findById.mockResolvedValue({ id: "d1", kbId: "kb1", status: "failed", metadata: {}, lifecycle: [], chunkVersion: null, uploadedAt: new Date(), updatedAt: new Date() });
    const svc = makeService(deps);
    await svc.triggerParse("d1", { profileId: "faq-v1", profileVersion: 1 });
    expect(deps.ingestion.createRun).toHaveBeenCalledWith("d1", {
      retry: false,
      profileRef: { profileId: "faq-v1", profileVersion: 1 },
    });
    await svc.triggerParse("d1", { mode: "retry" });
    expect(deps.ingestion.createRun).toHaveBeenCalledWith("d1", { retry: true, profileRef: undefined });
  });

  it("getContent 返回 { text, markdown }，二者同值", async () => {
    const deps = makeDeps();
    deps.repo.findById.mockResolvedValue({ id: "d1", parsedText: "# 标题\n正文" } as never);
    const res = await makeService(deps).getContent("d1");
    expect(res).toEqual({ documentId: "d1", text: "# 标题\n正文", markdown: "# 标题\n正文" });
  });

  it("listRuns 返回按 repo 顺序的 Run DTO（ISO 时间串，profileLabel 取自 snapshot.label）", async () => {
    const deps = makeDeps();
    deps.repo.findById.mockResolvedValue({ id: "d1" } as never);
    const created = new Date("2026-07-10T10:00:00.000Z");
    deps.runsRepo.findByDocument.mockResolvedValue([
      {
        id: "run-1",
        documentId: "d1",
        targetVersion: 2,
        profileId: "faq-v1",
        profileVersion: 1,
        profileSnapshot: { label: "FAQ 问答" },
        parserEngine: "pdf-parse",
        parserVersion: "2.4.5",
        status: "succeeded",
        warnings: [],
        metrics: { pages: 3 },
        error: null,
        startedAt: created,
        endedAt: created,
        createdAt: created,
      },
    ] as never);
    const runs = await makeService(deps).listRuns("d1");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: "run-1",
      profileLabel: "FAQ 问答",
      status: "succeeded",
      createdAt: "2026-07-10T10:00:00.000Z",
      startedAt: "2026-07-10T10:00:00.000Z",
    });
  });

  it("listRuns 文档不存在 → 404", async () => {
    const deps = makeDeps();
    deps.repo.findById.mockResolvedValue(undefined);
    await expect(makeService(deps).listRuns("gone")).rejects.toThrow(NotFoundException);
  });
});

// —— B1/F4：gold 过期通知的注册表反转（原型 §18.B）——

describe("gold-stale 通知（B1/F4）", () => {
  function serviceWithDoc() {
    const deps = makeDeps();
    deps.repo.findById.mockResolvedValue({
      id: "d1",
      kbId: "kb1",
      name: "退款政策.pdf",
      type: "pdf",
      size: 1024,
      blobKey: "kb/kb1/d1/original.pdf",
      chunkVersion: null,
      status: "ready",
      metadata: {},
      lifecycle: [],
      profileOverrideId: null,
      profileOverrideVersion: null,
      error: null,
      uploadedAt: new Date("2026-07-16T00:00:00.000Z"),
      updatedAt: new Date("2026-07-16T00:00:00.000Z"),
    });
    return { deps, service: makeService(deps) };
  }

  /**
   * 【时机】triggerParse 只是入队，切片内容此刻一个字都没变 ⇒ **不广播**。
   * 提前置位会留下这个洞：用户在解析窗口内点「确认仍有效」清掉标志，解析随后完成、
   * 内容真换了，而不会再有第二次广播——该用例从此静默失去过期提示（spec §4.2「完成后」）。
   * 广播出口在 `IngestionService` 的 ready 终态上，由 ingestion.service.spec.ts 钉住。
   */
  it("triggerParse（仅入队）不广播——广播挂在解析完成态", async () => {
    const { service } = serviceWithDoc();
    const notify = jest.fn(async () => undefined);
    service.registerGoldStaleNotifier(notify);

    await service.triggerParse("d1");
    expect(notify).not.toHaveBeenCalled();
  });

  it("remove 通知注册方", async () => {
    const { service } = serviceWithDoc();
    const notify = jest.fn(async () => undefined);
    service.registerGoldStaleNotifier(notify);

    await service.remove("d1");
    expect(notify).toHaveBeenCalledWith("d1");
  });

  /**
   * 【fail-open 不变量】评测集标不上「可能过期」是体验问题；
   * 因为它把一次文档删除打回失败，是事故。通知抛错**绝不**能冒泡。
   */
  it("通知抛错不影响文档主流程", async () => {
    const { deps, service } = serviceWithDoc();
    service.registerGoldStaleNotifier(async () => {
      throw new Error("eval domain down");
    });

    await expect(service.remove("d1")).resolves.toBeUndefined();
    expect(deps.repo.delete).toHaveBeenCalledWith("d1"); // 删除确实发生了
  });

  it("没有注册方时不报错（documents 可独立运行）", async () => {
    const { service } = serviceWithDoc();
    await expect(service.triggerParse("d1")).resolves.toBeDefined();
  });
});
