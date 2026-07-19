import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import type {
  Document,
  DocumentType,
  ParseDocumentRequest,
  ProcessingRun,
  UpdateDocumentMetadataRequest,
} from "@codecrush/contracts";
import { BLOB_STORE } from "../../platform/storage/blob-store.constants";
import type { BlobStore } from "../../platform/storage/blob-store.port";
import { AppConfigService } from "../../platform/config/config.service";
import { DocumentsRepository } from "./documents.repository";
import { KnowledgeBasesRepository } from "../knowledge-bases/knowledge-bases.repository";
import { ChunksRepository } from "../chunks/chunks.repository";
import { IngestionService } from "../ingestion/ingestion.service";
import { ProcessingRunsRepository } from "../ingestion/processing-runs.repository";
import { PROFILE_REGISTRY } from "../ingestion/ingestion.constants";
import type { ProfileRegistry } from "../ingestion/profiles/profile-registry";
import type { DocumentRow } from "./schema";
import type { ProcessingRunRow } from "../ingestion/schema";

// busboy 对 multipart 的 filename 参数按 latin1 解码，而浏览器实际发送 UTF-8 字节——
// 中文名会变 mojibake（"问" → "é—®" 一类）。latin1 往返无损：重解出 U+FFFD 说明原值
// 并非被误解码的 UTF-8（纯 ASCII 重解后不变，不受影响），保留原值兜底。
function decodeOriginalName(name: string): string {
  const decoded = Buffer.from(name, "latin1").toString("utf8");
  return decoded.includes("�") ? name : decoded;
}

export interface UploadedFileLike {
  originalname: string;
  buffer: Buffer;
  size: number;
  mimetype: string;
}

export interface UploadOptions {
  autoParse: boolean;
  // 整批统一的 Profile 覆盖（上传抽屉选定）；为空则各文档继承 KB 默认。
  profileId?: string;
  profileVersion?: number;
}

// 扩展名 -> DocumentType 白名单：只认服务端识别的四格式，未命中一律拒绝（不信任客户端 mimetype）。
const EXT_TO_TYPE: Record<string, DocumentType> = {
  ".pdf": "pdf",
  ".doc": "word",
  ".docx": "word",
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
};

function inferType(filename: string): DocumentType {
  const ext = extname(filename).toLowerCase();
  const type = EXT_TO_TYPE[ext];
  if (!type) {
    throw new BadRequestException(`不支持的文件类型: ${filename}`);
  }
  return type;
}

// magic bytes 最小校验：扩展名可伪造，对二进制格式核对文件头，防止把 HTML/脚本伪装成 pdf/docx 入库。
// markdown/text 是任意文本，不校验。.doc 旧格式（D0CF 复合文档）与 .docx（PK zip）都放行。
const MAGIC_CHECK: Partial<Record<DocumentType, (b: Buffer) => boolean>> = {
  pdf: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-",
  word: (b) =>
    (b[0] === 0x50 && b[1] === 0x4b) || // docx = zip "PK"
    (b[0] === 0xd0 && b[1] === 0xcf), // 旧 .doc 复合文档
};

function assertMagic(type: DocumentType, name: string, buffer: Buffer): void {
  const check = MAGIC_CHECK[type];
  if (check && !check(buffer)) {
    throw new BadRequestException(`文件内容与扩展名不符（疑似伪装）: ${name}`);
  }
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly repo: DocumentsRepository,
    private readonly kbRepo: KnowledgeBasesRepository,
    private readonly chunksRepo: ChunksRepository,
    @Inject(BLOB_STORE) private readonly blobStore: BlobStore,
    private readonly ingestion: IngestionService,
    private readonly config: AppConfigService,
    private readonly runsRepo: ProcessingRunsRepository,
    @Inject(PROFILE_REGISTRY) private readonly registry: ProfileRegistry,
  ) {}

  private readonly logger = new Logger(DocumentsService.name);

  /**
   * B1/F4：gold 过期通知。由 eval-runs 侧的 `GoldStaleNotifier` 在 `onModuleInit` 注册——
   * **documents 不认识 eval 域**，依赖方向保持 `eval-runs → documents` 单向
   * （范式同 `applications.service.ts:538-546` 的注册表反转）。
   */
  private goldStaleNotifiers: Array<(docId: string) => Promise<void>> = [];

  registerGoldStaleNotifier(fn: (docId: string) => Promise<void>): void {
    this.goldStaleNotifiers.push(fn);
  }

  /**
   * 通知失败**绝不**影响文档主流程——只记日志。
   * 评测集标不上「可能过期」是个体验问题；因为它把一次文档解析/删除打回失败，是事故。
   */
  private async notifyGoldStale(docId: string): Promise<void> {
    for (const fn of this.goldStaleNotifiers) {
      try {
        await fn(docId);
      } catch (err) {
        this.logger.warn(`gold-stale notify failed doc=${docId}: ${String(err)}`);
      }
    }
  }

  // M4.1 入库分流：开启 Profile 特性走新 Run 路径（建冻结快照 Run + 入队），否则 legacy chunkTemplate 入队。
  private async startIngestion(documentId: string, targetVersion: number): Promise<void> {
    if (this.config.processingProfilesEnabled) {
      await this.ingestion.createRun(documentId);
    } else {
      await this.ingestion.enqueue(documentId, targetVersion);
    }
  }

  async list(kbId: string): Promise<Document[]> {
    const rows = await this.repo.findByKb(kbId);
    // 一次分组查询填充各文档当前版本的切片数（按各自 chunkVersion 挑行，避免 N+1）。
    const counts = await this.chunksRepo.countByDocs(
      rows.filter((r) => r.chunkVersion !== null).map((r) => r.id),
    );
    const countMap = new Map(counts.map((c) => [`${c.docId}:${c.version}`, c.count]));
    return rows.map((r) =>
      this.toDocument(
        r,
        r.chunkVersion === null ? 0 : (countMap.get(`${r.id}:${r.chunkVersion}`) ?? 0),
      ),
    );
  }

  async upload(kbId: string, files: UploadedFileLike[], opts: UploadOptions): Promise<Document[]> {
    const kb = await this.kbRepo.findById(kbId);
    if (!kb) throw new NotFoundException(`knowledge base ${kbId} not found`);
    const targetVersion = kb.buildingVersion ?? kb.activeVersion;

    // 整批 Profile 覆盖（可选）：成对校验（半个 ref → 400）+ 存在性校验（未注册 → 400），先于任何副作用。
    const hasProfileId = opts.profileId !== undefined;
    const hasProfileVersion = opts.profileVersion !== undefined && !Number.isNaN(opts.profileVersion);
    if (hasProfileId !== hasProfileVersion) {
      throw new BadRequestException("profileId 与 profileVersion 必须成对提供");
    }
    if (hasProfileId && !this.registry.get(opts.profileId!, opts.profileVersion!)) {
      throw new BadRequestException(
        `[PROFILE_VERSION_UNAVAILABLE] 处理方案 ${opts.profileId}@${opts.profileVersion} 不可用`,
      );
    }

    // 先对整批做校验（类型白名单 + magic bytes），全部通过才开始任何副作用（落盘/建档/入队）：
    // 否则「前几个文件已持久化+已入队，随后某个文件校验失败返回 400」会造成错误响应背后的部分提交，
    // 客户端把整批当失败重传时产生重复文档。
    const validated = files.map((file) => {
      const name = decodeOriginalName(file.originalname);
      const type = inferType(name);
      assertMagic(type, name, file.buffer);
      return { file, name, type };
    });

    const created: Document[] = [];
    for (const { file, name, type } of validated) {
      const docId = randomUUID();
      // blob key 完全服务端拼装：docId 是 randomUUID()，扩展名来自白名单映射——不掺入任何客户端路径片段。
      const blobKey = `kb/${kbId}/${docId}/original.${type}`;
      await this.blobStore.put(blobKey, file.buffer);

      const row = await this.repo.insert({
        kbId,
        name,
        type,
        size: file.size,
        blobKey,
        status: "pending",
        profileOverrideId: opts.profileId ?? null,
        profileOverrideVersion: opts.profileId !== undefined ? opts.profileVersion! : null,
      });
      await this.repo.appendLifecycleStage(row.id, {
        stage: "upload",
        status: "done",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      });

      if (opts.autoParse) {
        await this.startIngestion(row.id, targetVersion);
      }
      created.push(this.toDocument((await this.repo.findById(row.id)) ?? row));
    }
    return created;
  }

  // 手动解析/重试/换方案重解析：空 body = 用当前有效 Profile；mode:'retry' = 复用最近失败 Run 快照；
  // 带完整 profile ref = 显式换方案（createRun 内写回文档 override）。flag=false 时忽略 req 走 legacy enqueue。
  async triggerParse(id: string, req: ParseDocumentRequest = {}): Promise<Document> {
    const doc = await this.mustFind(id);
    const kb = await this.kbRepo.findById(doc.kbId);
    if (!kb) throw new NotFoundException(`knowledge base ${doc.kbId} not found`);
    const targetVersion = kb.buildingVersion ?? kb.activeVersion;
    if (this.config.processingProfilesEnabled) {
      await this.ingestion.createRun(id, {
        retry: req.mode === "retry",
        profileRef:
          req.profileId !== undefined
            ? { profileId: req.profileId, profileVersion: req.profileVersion! }
            : undefined,
      });
    } else {
      await this.ingestion.enqueue(id, targetVersion);
    }
    // B1/F4：重解析会换掉切片内容 ⇒ 引用该文档的 gold 可能已经对不上了。
    await this.notifyGoldStale(id);
    return this.withCount(await this.mustFind(id));
  }

  // 文档处理历史：按 createdAt desc 的 Run 列表（profileLabel 取自冻结快照，前端免拉方案映射）。
  async listRuns(id: string): Promise<ProcessingRun[]> {
    await this.mustFind(id);
    const rows = await this.runsRepo.findByDocument(id);
    return rows.map((row) => this.toProcessingRun(row));
  }

  private toProcessingRun(row: ProcessingRunRow): ProcessingRun {
    const snapshot = row.profileSnapshot as { label?: string };
    return {
      id: row.id,
      documentId: row.documentId,
      targetVersion: row.targetVersion,
      profileId: row.profileId,
      profileVersion: row.profileVersion,
      profileLabel: snapshot.label ?? row.profileId,
      parserEngine: row.parserEngine,
      parserVersion: row.parserVersion,
      status: row.status as ProcessingRun["status"],
      warnings: row.warnings,
      metrics: row.metrics,
      error: row.error,
      startedAt: row.startedAt ? row.startedAt.toISOString() : null,
      endedAt: row.endedAt ? row.endedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async getLifecycle(id: string) {
    const doc = await this.mustFind(id);
    return { documentId: id, stages: doc.lifecycle };
  }

  async getContent(id: string) {
    const doc = await this.mustFind(id);
    // 迁移期 parsedText 即 canonical markdown，text 与 markdown 同值（前端可择一渲染）。
    const text = doc.parsedText ?? "";
    return { documentId: id, text, markdown: text };
  }

  async updateMetadata(id: string, req: UpdateDocumentMetadataRequest): Promise<Document> {
    await this.mustFind(id);
    const row = await this.repo.update(id, { metadata: req.metadata });
    if (!row) throw new NotFoundException(`document ${id} not found`);
    return this.withCount(row);
  }

  async remove(id: string): Promise<void> {
    const doc = await this.mustFind(id);
    try {
      await this.blobStore.delete(doc.blobKey);
    } catch {
      // 孤儿 blob 是可接受的轻量代价（spec.md 决策）：不让对象存储瞬时故障阻塞文档删除
    }
    await this.repo.delete(id);
    // B1/F4：文档没了，引用它的 gold 一定要人工复核（绝不自动改 gold —— 原型 §7）。
    await this.notifyGoldStale(id);
  }

  private async mustFind(id: string): Promise<DocumentRow> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundException(`document ${id} not found`);
    return row;
  }

  // 单文档响应的切片数：未解析（chunkVersion null）恒为 0，否则按该文档当前版本计数。
  private async withCount(row: DocumentRow): Promise<Document> {
    if (row.chunkVersion === null) return this.toDocument(row, 0);
    const counts = await this.chunksRepo.countByDocs([row.id]);
    const hit = counts.find((c) => c.version === row.chunkVersion);
    return this.toDocument(row, hit?.count ?? 0);
  }

  private toDocument(row: DocumentRow, chunksCount = 0): Document {
    return {
      id: row.id,
      kbId: row.kbId,
      name: row.name,
      type: row.type as DocumentType,
      size: row.size,
      chunksCount,
      chunkVersion: row.chunkVersion,
      status: row.status as Document["status"],
      metadata: row.metadata,
      profileOverrideId: row.profileOverrideId,
      profileOverrideVersion: row.profileOverrideVersion,
      error: row.error,
      uploadedAt: row.uploadedAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
