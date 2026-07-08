import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import type { Document, DocumentType, UpdateDocumentMetadataRequest } from "@codecrush/contracts";
import { BLOB_STORE } from "../../platform/storage/blob-store.constants";
import type { BlobStore } from "../../platform/storage/blob-store.port";
import { DocumentsRepository } from "./documents.repository";
import { KnowledgeBasesRepository } from "../knowledge-bases/knowledge-bases.repository";
import { IngestionService } from "../ingestion/ingestion.service";
import type { DocumentRow } from "./schema";

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
    @Inject(BLOB_STORE) private readonly blobStore: BlobStore,
    private readonly ingestion: IngestionService,
  ) {}

  async list(kbId: string): Promise<Document[]> {
    return (await this.repo.findByKb(kbId)).map((r) => this.toDocument(r));
  }

  async upload(kbId: string, files: UploadedFileLike[], opts: UploadOptions): Promise<Document[]> {
    const kb = await this.kbRepo.findById(kbId);
    if (!kb) throw new NotFoundException(`knowledge base ${kbId} not found`);
    const targetVersion = kb.buildingVersion ?? kb.activeVersion;

    const created: Document[] = [];
    for (const file of files) {
      const type = inferType(file.originalname);
      const docId = randomUUID();
      // blob key 完全服务端拼装：docId 是 randomUUID()，扩展名来自白名单映射——不掺入任何客户端路径片段。
      const blobKey = `kb/${kbId}/${docId}/original.${type}`;
      await this.blobStore.put(blobKey, file.buffer);

      const row = await this.repo.insert({
        kbId,
        name: file.originalname,
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
    return this.toDocument(await this.mustFind(id));
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
    return this.toDocument(row);
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

  private toDocument(row: DocumentRow): Document {
    return {
      id: row.id,
      kbId: row.kbId,
      name: row.name,
      type: row.type as DocumentType,
      size: row.size,
      chunksCount: 0, // 见 Task 18 收尾注：跨表聚合计数留待补齐
      chunkVersion: row.chunkVersion,
      status: row.status as Document["status"],
      metadata: row.metadata,
      error: row.error,
      uploadedAt: row.uploadedAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
