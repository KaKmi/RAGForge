import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, ilike, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { PromptListQuery } from "@codecrush/contracts";
import { DRIZZLE } from "../../platform/persistence/drizzle.constants";
import type { DB } from "../../platform/persistence/persistence.module";
import {
  prompts,
  promptVersions,
  type NewPrompt,
  type NewPromptVersion,
  type PromptRow,
  type PromptVersionRow,
} from "./schema";

// list 端点 join 聚合（currentVersionNumber + versionCount），前端一次拿全避免 N+1
export type PromptListRow = PromptRow & {
  currentVersionNumber: number | null;
  versionCount: number;
};

export interface PromptListResult {
  items: PromptListRow[];
  total: number;
}

const PROMPT_AGG_SELECT = {
  id: prompts.id,
  name: prompts.name,
  node: prompts.node,
  currentVersionId: prompts.currentVersionId,
  createdAt: prompts.createdAt,
  updatedAt: prompts.updatedAt,
  updatedBy: prompts.updatedBy,
  // 注意：drizzle 的 sql 模板里 `${prompts.x}` 渲染成未限定的 `"x"`，
  // 在相关子查询中会被内层表（prompt_versions 也有 id 列）抢解析。
  // 必须显式限定外层引用为 "prompts"."x"。
  currentVersionNumber: sql<number | null>`(
    SELECT ${promptVersions.version} FROM ${promptVersions}
    WHERE ${promptVersions.id} = "prompts"."current_version_id"
  )`.as("current_version_number"),
  versionCount: sql<number>`(
    SELECT COUNT(*)::int FROM ${promptVersions}
    WHERE ${promptVersions.promptId} = "prompts"."id"
  )`.as("version_count"),
} as const;

@Injectable()
export class PromptsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  // 分页 + 条件查询：search（name/updatedBy ILIKE）+ node + status（prod/draft 按 currentVersionId 是否 null）
  // 注：ILIKE 未转义 %/_ 通配符（demo 环境搜索词不太会含，后端真实化时再加 escape）
  async findPrompts(q: PromptListQuery): Promise<PromptListResult> {
    const conditions: Array<SQL | undefined> = [];
    if (q.search) {
      const like = `%${q.search}%`;
      conditions.push(or(ilike(prompts.name, like), ilike(prompts.updatedBy, like)));
    }
    if (q.node) conditions.push(eq(prompts.node, q.node));
    if (q.status === "prod") conditions.push(isNotNull(prompts.currentVersionId));
    if (q.status === "draft") conditions.push(isNull(prompts.currentVersionId));
    const where = conditions.length ? and(...conditions) : undefined;

    const [items, totalRows] = await Promise.all([
      this.db
        .select(PROMPT_AGG_SELECT)
        .from(prompts)
        .where(where)
        .orderBy(desc(prompts.updatedAt))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize),
      this.db.select({ count: count() }).from(prompts).where(where),
    ]);
    return { items, total: totalRows[0]?.count ?? 0 };
  }

  async findPromptById(id: string): Promise<PromptListRow | undefined> {
    const rows = await this.db
      .select(PROMPT_AGG_SELECT)
      .from(prompts)
      .where(eq(prompts.id, id))
      .limit(1);
    return rows[0];
  }

  async insertPrompt(row: NewPrompt): Promise<PromptRow> {
    const rows = await this.db.insert(prompts).values(row).returning();
    return rows[0];
  }

  async findVersions(promptId: string): Promise<PromptVersionRow[]> {
    return await this.db
      .select()
      .from(promptVersions)
      .where(eq(promptVersions.promptId, promptId));
  }

  async findVersionById(versionId: string): Promise<PromptVersionRow | undefined> {
    const rows = await this.db
      .select()
      .from(promptVersions)
      .where(eq(promptVersions.id, versionId))
      .limit(1);
    return rows[0];
  }

  async insertVersion(row: NewPromptVersion): Promise<PromptVersionRow> {
    const rows = await this.db.insert(promptVersions).values(row).returning();
    return rows[0];
  }

  async findProdVersion(promptId: string): Promise<PromptVersionRow | undefined> {
    const rows = await this.db
      .select()
      .from(promptVersions)
      .where(
        and(eq(promptVersions.promptId, promptId), eq(promptVersions.status, "prod")),
      )
      .limit(1);
    return rows[0];
  }

  // 发布/回滚事务（D2）：archive 旧 prod → set 新 prod → 更新 prompt.currentVersionId/updatedBy/updatedAt（D16）
  async publishVersion(
    promptId: string,
    versionId: string,
    actorEmail: string,
  ): Promise<PromptVersionRow> {
    return await this.db.transaction(async (tx) => {
      await tx
        .update(promptVersions)
        .set({ status: "archived" })
        .where(
          and(eq(promptVersions.promptId, promptId), eq(promptVersions.status, "prod")),
        );
      await tx
        .update(promptVersions)
        .set({ status: "prod" })
        .where(eq(promptVersions.id, versionId));
      await tx
        .update(prompts)
        .set({ currentVersionId: versionId, updatedBy: actorEmail, updatedAt: new Date() })
        .where(eq(prompts.id, promptId));
      const rows = await tx
        .select()
        .from(promptVersions)
        .where(eq(promptVersions.id, versionId))
        .limit(1);
      const row = rows[0];
      if (!row) throw new Error(`publishVersion: version ${versionId} vanished after update`);
      return row;
    });
  }

  // 删除 prompt（仅草稿允许；versions 由外键 ON DELETE CASCADE 级联删，无需手动清）
  async deletePrompt(id: string): Promise<void> {
    await this.db.delete(prompts).where(eq(prompts.id, id));
  }
}
