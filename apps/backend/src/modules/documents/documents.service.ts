import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import type { Document, DocumentType, UpdateDocumentMetadataRequest } from "@codecrush/contracts";
import { BLOB_STORE } from "../../platform/storage/blob-store.constants";
import type { BlobStore } from "../../platform/storage/blob-store.port";
import { DocumentsRepository } from "./documents.repository";
import { KnowledgeBasesRepository } from "../knowledge-bases/knowledge-bases.repository";
import { ChunksRepository } from "../chunks/chunks.repository";
import { IngestionService } from "../ingestion/ingestion.service";
import type { DocumentRow } from "./schema";

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

@Injectable()
export class DocumentsService {
  constructor(
    private readonly repo: DocumentsRepository,
    private readonly kbRepo: KnowledgeBasesRepository,
    private readonly chunksRepo: ChunksRepository,
    @Inject(BLOB_STORE) private readonly blobStore: BlobStore,
    private readonly ingestion: IngestionService,
  ) {}

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

    // 先对整批做校验（类型白名单），全部通过才开始任何副作用（落盘/建档/入队）：
    // 否则「前几个文件已持久化+已入队，随后某个文件校验失败返回 400」会造成错误响应背后的部分提交，
    // 客户端把整批当失败重传时产生重复文档。
    const validated = files.map((file) => {
      const name = decodeOriginalName(file.originalname);
      return { file, name, type: inferType(name) };
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
      });
      await this.repo.appendLifecycleStage(row.id, {
        stage: "upload",
        status: "done",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      });

      if (opts.autoParse) {
        await this.ingestion.enqueue(row.id, targetVersion);
      }
      created.push(this.toDocument((await this.repo.findById(row.id)) ?? row));
    }
    return created;
  }

  async triggerParse(id: string): Promise<Document> {
    const doc = await this.mustFind(id);
    const kb = await this.kbRepo.findById(doc.kbId);
    if (!kb) throw new NotFoundException(`knowledge base ${doc.kbId} not found`);
    const targetVersion = kb.buildingVersion ?? kb.activeVersion;
    await this.ingestion.enqueue(id, targetVersion);
    return this.withCount(await this.mustFind(id));
  }

  async getLifecycle(id: string) {
    const doc = await this.mustFind(id);
    return { documentId: id, stages: doc.lifecycle };
  }

  async getContent(id: string) {
    const doc = await this.mustFind(id);
    return { documentId: id, text: doc.parsedText ?? "" };
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
      error: row.error,
      uploadedAt: row.uploadedAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
