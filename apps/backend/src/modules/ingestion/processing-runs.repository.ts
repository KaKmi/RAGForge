import { Inject, Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../platform/persistence/drizzle.constants";
import type { DB } from "../../platform/persistence/persistence.module";
import {
  documentProcessingRuns,
  type NewProcessingRun,
  type ProcessingRunRow,
} from "./schema";

export function isActiveRunConflict(error: unknown): boolean {
  const candidate = (error as { cause?: unknown } | null)?.cause ?? error;
  const pgError = candidate as { code?: string; constraint?: string } | null;
  return pgError?.code === "23505" && pgError.constraint === "dpr_active_doc_unique";
}

@Injectable()
export class ProcessingRunsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  async insert(row: NewProcessingRun): Promise<ProcessingRunRow> {
    const rows = await this.db.insert(documentProcessingRuns).values(row).returning();
    return rows[0];
  }

  async findById(id: string): Promise<ProcessingRunRow | undefined> {
    const rows = await this.db
      .select()
      .from(documentProcessingRuns)
      .where(eq(documentProcessingRuns.id, id))
      .limit(1);
    return rows[0];
  }

  async findByDocument(documentId: string): Promise<ProcessingRunRow[]> {
    return await this.db
      .select()
      .from(documentProcessingRuns)
      .where(eq(documentProcessingRuns.documentId, documentId))
      .orderBy(desc(documentProcessingRuns.createdAt));
  }

  async update(
    id: string,
    patch: Partial<NewProcessingRun>,
  ): Promise<ProcessingRunRow | undefined> {
    const rows = await this.db
      .update(documentProcessingRuns)
      .set(patch)
      .where(eq(documentProcessingRuns.id, id))
      .returning();
    return rows[0];
  }
}
