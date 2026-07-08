import { Inject, Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
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

  async delete(id: string): Promise<void> {
    await this.db.delete(documents).where(eq(documents.id, id));
  }
}
