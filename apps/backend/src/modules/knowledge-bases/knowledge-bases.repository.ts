import { Inject, Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../platform/persistence/drizzle.constants";
import type { DB } from "../../platform/persistence/persistence.module";
import { knowledgeBases, type KnowledgeBaseRow, type NewKnowledgeBase } from "./schema";

export interface VersionUpdate {
  activeVersion?: number;
  buildingVersion?: number | null;
  status?: string;
}

@Injectable()
export class KnowledgeBasesRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  async find(): Promise<KnowledgeBaseRow[]> {
    return await this.db.select().from(knowledgeBases).orderBy(desc(knowledgeBases.updatedAt));
  }

  async findById(id: string): Promise<KnowledgeBaseRow | undefined> {
    const rows = await this.db
      .select()
      .from(knowledgeBases)
      .where(eq(knowledgeBases.id, id))
      .limit(1);
    return rows[0];
  }

  async findByName(name: string): Promise<KnowledgeBaseRow | undefined> {
    const rows = await this.db
      .select()
      .from(knowledgeBases)
      .where(eq(knowledgeBases.name, name))
      .limit(1);
    return rows[0];
  }

  async insert(row: NewKnowledgeBase): Promise<KnowledgeBaseRow> {
    const rows = await this.db.insert(knowledgeBases).values(row).returning();
    return rows[0];
  }

  async update(
    id: string,
    patch: Partial<NewKnowledgeBase>,
  ): Promise<KnowledgeBaseRow | undefined> {
    const rows = await this.db
      .update(knowledgeBases)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(knowledgeBases.id, id))
      .returning();
    return rows[0];
  }

  // 版本切换专用：只碰 active/building/status 三列，避免通用 update() 误覆盖并发中的 desc/chunkTemplate 改动
  async updateVersions(id: string, patch: VersionUpdate): Promise<KnowledgeBaseRow | undefined> {
    const rows = await this.db
      .update(knowledgeBases)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(knowledgeBases.id, id))
      .returning();
    return rows[0];
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(knowledgeBases).where(eq(knowledgeBases.id, id));
  }
}
