import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, ilike, inArray, sql } from "drizzle-orm";
import { DRIZZLE } from "../../platform/persistence/drizzle.constants";
import type { DB } from "../../platform/persistence/persistence.module";
import { chunks, type ChunkDraft, type ChunkRow } from "./schema";

export interface ChunkPage {
  items: ChunkRow[];
  total: number;
}

@Injectable()
export class ChunksRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  async findPage(
    docId: string,
    version: number,
    opts: { offset: number; limit: number; q?: string },
  ): Promise<ChunkPage> {
    const conds = [eq(chunks.docId, docId), eq(chunks.version, version)];
    if (opts.q) conds.push(ilike(chunks.text, `%${opts.q}%`));
    const where = and(...conds);

    const [items, totalRows] = await Promise.all([
      this.db
        .select()
        .from(chunks)
        .where(where)
        .orderBy(asc(chunks.seq))
        .offset(opts.offset)
        .limit(opts.limit),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(chunks)
        .where(where),
    ]);
    return { items, total: totalRows[0]?.count ?? 0 };
  }

  // 按 (docId, version) 分组计数：文档列表一次查询填充 chunksCount，避免 N+1；
  // 调用方按各文档自己的 chunkVersion 挑选对应行（重建中间态下不同文档版本可能不同）。
  async countByDocs(
    docIds: string[],
  ): Promise<Array<{ docId: string; version: number; count: number }>> {
    if (docIds.length === 0) return [];
    return await this.db
      .select({ docId: chunks.docId, version: chunks.version, count: sql<number>`count(*)::int` })
      .from(chunks)
      .where(inArray(chunks.docId, docIds))
      .groupBy(chunks.docId, chunks.version);
  }

  // 按 (kbId, version) 分组计数：知识库列表填充 chunksCount，调用方按 kb.activeVersion 挑行。
  async countByKbVersions(
    kbIds: string[],
  ): Promise<Array<{ kbId: string; version: number; count: number }>> {
    if (kbIds.length === 0) return [];
    return await this.db
      .select({ kbId: chunks.kbId, version: chunks.version, count: sql<number>`count(*)::int` })
      .from(chunks)
      .where(inArray(chunks.kbId, kbIds))
      .groupBy(chunks.kbId, chunks.version);
  }

  // 单文档（重新）入库终点：单事务删旧插新，检索侧不会看到空窗（007 Invariant 1/3）
  async replaceVersion(
    docId: string,
    kbId: string,
    version: number,
    drafts: ChunkDraft[],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(chunks).where(and(eq(chunks.docId, docId), eq(chunks.version, version)));
      if (drafts.length === 0) return;
      await tx.insert(chunks).values(
        drafts.map((d) => ({
          docId,
          kbId,
          version,
          seq: d.seq,
          text: d.text,
          tokenCount: d.tokenCount,
          section: d.section,
          embedding: d.embedding,
        })),
      );
    });
  }

  async batchDelete(ids: string[]): Promise<number> {
    const deleted = await this.db
      .delete(chunks)
      .where(inArray(chunks.id, ids))
      .returning({ id: chunks.id });
    return deleted.length;
  }

  // 全库重建切换后，异步分批清理旧版本切片（不进切换事务，避免大删拖慢原子切换）
  async deleteByVersion(kbId: string, version: number): Promise<number> {
    const deleted = await this.db
      .delete(chunks)
      .where(and(eq(chunks.kbId, kbId), eq(chunks.version, version)))
      .returning({ id: chunks.id });
    return deleted.length;
  }
}
