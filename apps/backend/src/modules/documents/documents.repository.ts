import { Inject, Injectable } from "@nestjs/common";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { DRIZZLE } from "../../platform/persistence/drizzle.constants";
import type { DB } from "../../platform/persistence/persistence.module";
import { documents, type DocumentRow, type LifecycleStageRow, type NewDocument } from "./schema";

@Injectable()
export class DocumentsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  async find(): Promise<DocumentRow[]> {
    return await this.db.select().from(documents).orderBy(desc(documents.uploadedAt));
  }

  async findByKb(kbId: string): Promise<DocumentRow[]> {
    return await this.db
      .select()
      .from(documents)
      .where(eq(documents.kbId, kbId))
      .orderBy(desc(documents.uploadedAt));
  }

  async findById(id: string): Promise<DocumentRow | undefined> {
    const rows = await this.db.select().from(documents).where(eq(documents.id, id)).limit(1);
    return rows[0];
  }

  async insert(row: NewDocument): Promise<DocumentRow> {
    const rows = await this.db.insert(documents).values(row).returning();
    return rows[0];
  }

  async update(id: string, patch: Partial<NewDocument>): Promise<DocumentRow | undefined> {
    const rows = await this.db
      .update(documents)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(documents.id, id))
      .returning();
    return rows[0];
  }

  async appendLifecycleStage(id: string, stage: LifecycleStageRow): Promise<void> {
    const row = await this.findById(id);
    if (!row) return;
    const lifecycle = [...row.lifecycle, stage];
    await this.db
      .update(documents)
      .set({ lifecycle, updatedAt: new Date() })
      .where(eq(documents.id, id));
  }

  // 终态时闭合最近一个未结束的同名阶段（status=running 且 endedAt 为空），写入终态与耗时终点。
  // 与 appendLifecycleStage 同为 RMW（每文档单 worker，singletonKey=documentId 序列化）。
  // 返回是否找到可闭合项——找不到（如历史数据）由调用方回退 append。
  async completeLifecycleStage(
    id: string,
    stage: LifecycleStageRow["stage"],
    patch: Pick<LifecycleStageRow, "status" | "endedAt"> & { error?: string | null },
  ): Promise<boolean> {
    const row = await this.findById(id);
    if (!row) return false;
    const lifecycle = [...row.lifecycle];
    for (let i = lifecycle.length - 1; i >= 0; i--) {
      const s = lifecycle[i];
      if (s.stage === stage && s.status === "running" && !s.endedAt) {
        lifecycle[i] = { ...s, ...patch };
        await this.db
          .update(documents)
          .set({ lifecycle, updatedAt: new Date() })
          .where(eq(documents.id, id));
        return true;
      }
    }
    return false;
  }

  // 按 kbId 分组计数：知识库列表填充 docsCount。
  async countByKbs(kbIds: string[]): Promise<Array<{ kbId: string; count: number }>> {
    if (kbIds.length === 0) return [];
    return await this.db
      .select({ kbId: documents.kbId, count: sql<number>`count(*)::int` })
      .from(documents)
      .where(inArray(documents.kbId, kbIds))
      .groupBy(documents.kbId);
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(documents).where(eq(documents.id, id));
  }
}
