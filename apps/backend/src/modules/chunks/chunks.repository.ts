import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, ilike, inArray, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DRIZZLE } from "../../platform/persistence/drizzle.constants";
import type { DB } from "../../platform/persistence/persistence.module";
import { chunks, type ChunkDraft, type ChunkRow } from "./schema";
import { documents } from "../documents/schema";

export interface ChunkPage {
  items: ChunkRow[];
  total: number;
}

export interface VectorCandidate {
  chunkId: string;
  docId: string;
  docName: string;
  text: string;
  section: string;
  vecScore: number;
}

export interface KeywordCandidate {
  chunkId: string;
  docId: string;
  docName: string;
  text: string;
  section: string;
  kwScore: number;
}

// deleteByVersion 分批大小：设计 007:62/132 要求"异步分批清理旧版切片"（大删不进切换事务，
// 避免长行锁 + 大 WAL + 一次性 RETURNING 全量 id 造成的内存尖峰）。1000 是任意但保守的批量。
const DELETE_BATCH_SIZE = 1000;

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
          processingRunId: d.processingRunId,
          contentType: d.contentType,
          pageStart: d.pageStart,
          pageEnd: d.pageEnd,
          assetKey: d.assetKey,
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

  // 重建切换前调用：把「本轮未被重新处理」的文档（scope='inherited' 排除的文档、per-doc
  // 409/400 被跳过的文档、reparse 失败仍保留旧结果的文档）的切片从旧版本前移到新版本，
  // 使其在切换后继续满足检索契约 `chunks.version = kb.active_version`，不被下方
  // deleteByVersion 当作「已被替换的旧切片」误删（QA P1：scope='inherited' 静默清空
  // 被排除文档的可检索内容）。
  //
  // NOT EXISTS 排除「该文档在 toVersion 已有同 seq 切片」的行（review P2）：调用方基于
  // documents.chunkVersion 这个非原子信号判断"本轮未推进"，但该字段的写入落后于 chunks
  // 表——文档若被本轮官方重建排除、却又被用户独立触发了目标版本恰好也是 toVersion 的重解析，
  // 会出现"chunkVersion 读到旧值、但 chunks 表已有 toVersion 新切片"的窗口。此时这些新切片
  // 才是该文档的最新内容，不该被旧内容覆盖，也不需要前移——旧内容留给下方 deleteByVersion
  // 按 fromVersion 正常清理，不做特殊处理。NOT EXISTS 天然规避了 chunks_doc_version_seq_unique
  // 唯一约束冲突，不需要调用方自证「确实未在本轮写入 toVersion」。
  async carryForwardVersion(
    kbId: string,
    docIds: string[],
    fromVersion: number,
    toVersion: number,
  ): Promise<void> {
    if (docIds.length === 0) return;
    const existing = alias(chunks, "existing_at_to_version");
    await this.db
      .update(chunks)
      .set({ version: toVersion })
      .where(
        and(
          eq(chunks.kbId, kbId),
          eq(chunks.version, fromVersion),
          inArray(chunks.docId, docIds),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(existing)
              .where(
                and(
                  eq(existing.docId, chunks.docId),
                  eq(existing.version, toVersion),
                  eq(existing.seq, chunks.seq),
                ),
              ),
          ),
        ),
      );
  }

  // 全库重建切换后，异步分批清理旧版本切片（不进切换事务，避免大删拖慢原子切换）。
  // 分批：每轮只删 DELETE_BATCH_SIZE 条（子查询选 id 再按 id 删），避免单条超大 DELETE
  // 长时间持有行锁、产生巨量 WAL，以及一次性 RETURNING 全量 id 造成的 Node 内存尖峰。
  async deleteByVersion(kbId: string, version: number): Promise<number> {
    let totalDeleted = 0;
    for (;;) {
      const batchIds = this.db
        .select({ id: chunks.id })
        .from(chunks)
        .where(and(eq(chunks.kbId, kbId), eq(chunks.version, version)))
        .limit(DELETE_BATCH_SIZE);
      const deleted = await this.db
        .delete(chunks)
        .where(inArray(chunks.id, batchIds))
        .returning({ id: chunks.id });
      totalDeleted += deleted.length;
      if (deleted.length < DELETE_BATCH_SIZE) break;
    }
    return totalDeleted;
  }

  // 向量召回：pgvector <=> 是 cosine distance（HNSW 索引 vector_cosine_ops 已在迁移 0006 建好），
  // 1 - distance 换算成 [0,1] 相似度分数（008 §数据流程图）。leftJoin documents 直接带出 docName，
  // 不新增 retrieval→documents 依赖边（chunks 模块本就依赖 documents，schema.ts 已引用其表对象）。
  async searchByVector(
    kbId: string,
    version: number,
    embedding: number[],
    limit: number,
  ): Promise<VectorCandidate[]> {
    const vecLiteral = `[${embedding.join(",")}]`;
    const rows = await this.db
      .select({
        chunkId: chunks.id,
        docId: chunks.docId,
        docName: documents.name,
        text: chunks.text,
        section: chunks.section,
        vecScore: sql<number>`1 - (${chunks.embedding} <=> ${vecLiteral}::vector)`,
      })
      .from(chunks)
      .leftJoin(documents, eq(chunks.docId, documents.id))
      .where(and(eq(chunks.kbId, kbId), eq(chunks.version, version)))
      .orderBy(sql`${chunks.embedding} <=> ${vecLiteral}::vector`)
      .limit(limit);
    return rows.map((r) => ({ ...r, docName: r.docName ?? "", vecScore: Number(r.vecScore) }));
  }

  // 关键词召回：query 与索引侧共用 cjk_bigram_text（迁移 0008），bigram token 以 |（OR）连接成
  // tsquery——避免任何单字差异导致零命中，ts_rank 天然按命中 bigram 数量区分相关度。
  // ts_rank_cd(...,32) 内置归一化 rank/(rank+1) ∈ [0,1)，对 (文档,查询) 确定、不依赖候选池组成
  // （008 §kwScore 归一化，拒绝候选池内 min-max）。
  async searchByKeyword(
    kbId: string,
    version: number,
    query: string,
    limit: number,
  ): Promise<KeywordCandidate[]> {
    // 剥离标点：ASCII 的 ( ) & | ! : * 等是 tsquery 语法字符，经 bigram 透传后会让 to_tsquery
    // 直接语法报错（实测 '退货(7天)!' 必炸），整路降级；而索引侧 to_tsvector('simple') 本来就把
    // 标点当分隔符丢弃，查询侧剥掉保持两侧语义对齐。全剥空则无可查 token，短路返回。
    const cleaned = query.replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
    if (!cleaned) return [];
    const tsq = sql`to_tsquery('simple', regexp_replace(cjk_bigram_text(${cleaned}), '\\s+', ' | ', 'g'))`;
    const rankExpr = sql<number>`ts_rank_cd(${chunks.tsv}, ${tsq}, 32)`;
    const rows = await this.db
      .select({
        chunkId: chunks.id,
        docId: chunks.docId,
        docName: documents.name,
        text: chunks.text,
        section: chunks.section,
        kwScore: rankExpr,
      })
      .from(chunks)
      .leftJoin(documents, eq(chunks.docId, documents.id))
      .where(and(eq(chunks.kbId, kbId), eq(chunks.version, version), sql`${chunks.tsv} @@ ${tsq}`))
      .orderBy(sql`${rankExpr} DESC`)
      .limit(limit);
    return rows.map((r) => ({ ...r, docName: r.docName ?? "", kwScore: Number(r.kwScore) }));
  }
}
