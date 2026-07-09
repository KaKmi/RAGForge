import { Injectable, NotFoundException } from "@nestjs/common";
import type { Chunk, ChunkBatchDeleteResponse, ChunkListQuery, ChunkPageResponse } from "@codecrush/contracts";
import { ChunksRepository } from "./chunks.repository";
import { DocumentsRepository } from "../documents/documents.repository";
import type { ChunkRow } from "./schema";

@Injectable()
export class ChunksService {
  constructor(
    private readonly chunksRepo: ChunksRepository,
    private readonly docsRepo: DocumentsRepository,
  ) {}

  async listPage(docId: string, query: ChunkListQuery): Promise<ChunkPageResponse> {
    const doc = await this.docsRepo.findById(docId);
    if (!doc) throw new NotFoundException(`document ${docId} not found`);

    // 版本过滤用文档自己的 chunkVersion（非 kb.activeVersion）：单文档重解析中间态下
    // 二者可能短暂不同，文档自身 chunkVersion 才是它当前可见切片所属版本。
    if (doc.chunkVersion === null) {
      return { items: [], total: 0, offset: query.offset, limit: query.limit, hasMore: false };
    }

    const page = await this.chunksRepo.findPage(docId, doc.chunkVersion, {
      offset: query.offset,
      limit: query.limit,
      q: query.q,
    });
    return {
      items: page.items.map((r) => this.toChunk(r)),
      total: page.total,
      offset: query.offset,
      limit: query.limit,
      hasMore: query.offset + page.items.length < page.total,
    };
  }

  async batchDelete(ids: string[]): Promise<ChunkBatchDeleteResponse> {
    const deletedCount = await this.chunksRepo.batchDelete(ids);
    return { deletedCount };
  }

  private toChunk(row: ChunkRow): Chunk {
    return {
      id: row.id,
      docId: row.docId,
      kbId: row.kbId,
      version: row.version,
      seq: row.seq,
      text: row.text,
      tokenCount: row.tokenCount,
      section: row.section,
    };
  }
}
