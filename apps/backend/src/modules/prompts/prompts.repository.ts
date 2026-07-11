import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { PromptListQuery } from "@codecrush/contracts";
import { DRIZZLE } from "../../platform/persistence/drizzle.constants";
import type { DB } from "../../platform/persistence/persistence.module";
import {
  prompts,
  promptVersions,
  promptVersionTags,
  type NewPrompt,
  type NewPromptVersion,
  type PromptRow,
  type PromptVersionRow,
} from "./schema";

// 012：列表聚合行 = prompt + 最新版本摘要（实时 ORDER BY version DESC LIMIT 1，无持久化指针）
export type PromptListRow = Omit<PromptRow, "currentVersionId"> & {
  latestVersionId: string | null;
  latestVersion: number | null;
  latestVariables: string[] | null;
  versionCount: number;
};

export interface PromptListResult {
  items: PromptListRow[];
  total: number;
}

export interface TagRow {
  promptVersionId: string;
  name: string;
}

export interface TagWithVersionRow {
  name: string;
  versionId: string;
  version: number;
}

export interface NodeVersionCandidateRow {
  promptId: string;
  promptName: string;
  versionId: string;
  version: number;
  compileStatus: string | null;
  body: string;
  node: string;
  createdAt: Date;
}

// 注意：drizzle 的 sql 模板里 `${prompts.x}` 渲染成未限定的 `"x"`，
// 在相关子查询中会被内层表抢解析，外层引用必须显式限定 "prompts"."x"。
const PROMPT_AGG_SELECT = {
  id: prompts.id,
  name: prompts.name,
  node: prompts.node,
  createdAt: prompts.createdAt,
  updatedAt: prompts.updatedAt,
  updatedBy: prompts.updatedBy,
  latestVersionId: sql<string | null>`(
    SELECT ${promptVersions.id} FROM ${promptVersions}
    WHERE ${promptVersions.promptId} = "prompts"."id"
    ORDER BY ${promptVersions.version} DESC LIMIT 1
  )`.as("latest_version_id"),
  latestVersion: sql<number | null>`(
    SELECT ${promptVersions.version} FROM ${promptVersions}
    WHERE ${promptVersions.promptId} = "prompts"."id"
    ORDER BY ${promptVersions.version} DESC LIMIT 1
  )`.as("latest_version"),
  latestVariables: sql<string[] | null>`(
    SELECT ${promptVersions.variables} FROM ${promptVersions}
    WHERE ${promptVersions.promptId} = "prompts"."id"
    ORDER BY ${promptVersions.version} DESC LIMIT 1
  )`.as("latest_variables"),
  versionCount: sql<number>`(
    SELECT COUNT(*)::int FROM ${promptVersions}
    WHERE ${promptVersions.promptId} = "prompts"."id"
  )`.as("version_count"),
} as const;

@Injectable()
export class PromptsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  // 分页 + 条件查询：search（name/updatedBy ILIKE）+ node（012 去掉发布状态筛选）
  async findPrompts(q: PromptListQuery): Promise<PromptListResult> {
    const conditions: Array<SQL | undefined> = [];
    if (q.search) {
      const like = `%${q.search}%`;
      conditions.push(or(ilike(prompts.name, like), ilike(prompts.updatedBy, like)));
    }
    if (q.node) conditions.push(eq(prompts.node, q.node));
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

  // 012：建 Prompt + 空 v1 在同一事务（撞名唯一冲突原样抛给 service 归一 409）
  async createPromptWithV1(
    prompt: NewPrompt,
    versionSeed: Omit<NewPromptVersion, "promptId">,
  ): Promise<{ prompt: PromptRow; version: PromptVersionRow }> {
    return await this.db.transaction(async (tx) => {
      const created = (await tx.insert(prompts).values(prompt).returning())[0];
      const version = (
        await tx
          .insert(promptVersions)
          .values({ ...versionSeed, promptId: created.id })
          .returning()
      )[0];
      return { prompt: created, version };
    });
  }

  /** 历史版本按版本号降序（历史抽屉/详情一次拿全，顺序确定） */
  async findVersions(promptId: string): Promise<PromptVersionRow[]> {
    return await this.db
      .select()
      .from(promptVersions)
      .where(eq(promptVersions.promptId, promptId))
      .orderBy(desc(promptVersions.version));
  }

  async findVersionById(versionId: string): Promise<PromptVersionRow | undefined> {
    const rows = await this.db
      .select()
      .from(promptVersions)
      .where(eq(promptVersions.id, versionId))
      .limit(1);
    return rows[0];
  }

  // 保存新版本 + 刷新 prompt 更新人/时间在同一事务（review P2：两步分离会在
  // touch 失败时留下孤儿版本与过期元数据，重试还会再插一版）
  async insertVersion(row: NewPromptVersion, actorEmail: string): Promise<PromptVersionRow> {
    return await this.db.transaction(async (tx) => {
      const rows = await tx.insert(promptVersions).values(row).returning();
      await tx
        .update(prompts)
        .set({ updatedBy: actorEmail, updatedAt: new Date() })
        .where(eq(prompts.id, row.promptId));
      return rows[0];
    });
  }

  /** 某 Prompt 全部标签（键 = 版本 id），供版本 DTO 组装 */
  async findTagsByPromptId(promptId: string): Promise<TagRow[]> {
    return await this.db
      .select({ promptVersionId: promptVersionTags.promptVersionId, name: promptVersionTags.name })
      .from(promptVersionTags)
      .where(eq(promptVersionTags.promptId, promptId))
      .orderBy(asc(promptVersionTags.name));
  }

  /** 批量取多个版本的标签（列表页最新版本「标识」列，一次查询防 N+1） */
  async findTagsByVersionIds(versionIds: string[]): Promise<TagRow[]> {
    if (versionIds.length === 0) return [];
    return await this.db
      .select({ promptVersionId: promptVersionTags.promptVersionId, name: promptVersionTags.name })
      .from(promptVersionTags)
      .where(inArray(promptVersionTags.promptVersionId, versionIds))
      .orderBy(asc(promptVersionTags.name));
  }

  /** 标签 + 所指版本号（PUT/GET tags 响应形状） */
  async findTagsWithVersion(promptId: string): Promise<TagWithVersionRow[]> {
    return await this.db
      .select({
        name: promptVersionTags.name,
        versionId: promptVersionTags.promptVersionId,
        version: promptVersions.version,
      })
      .from(promptVersionTags)
      .innerJoin(promptVersions, eq(promptVersionTags.promptVersionId, promptVersions.id))
      .where(eq(promptVersionTags.promptId, promptId))
      .orderBy(asc(promptVersionTags.name));
  }

  // 012 §1 排他移动：一条原子 UPSERT，冲突目标是 (prompt_id, lower(name)) 表达式唯一索引。
  // 并发移动在行锁上天然串行（Invariant 5）；跨 Prompt 版本被复合 FK 直接拒绝（23503）。
  async upsertTag(
    promptId: string,
    versionId: string,
    name: string,
    actorEmail: string,
  ): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO ${promptVersionTags} (prompt_id, prompt_version_id, name, created_by)
      VALUES (${promptId}, ${versionId}, ${name}, ${actorEmail})
      ON CONFLICT (prompt_id, lower(name))
      DO UPDATE SET prompt_version_id = excluded.prompt_version_id,
                    created_at = now(),
                    created_by = excluded.created_by
    `);
  }

  /** 摘除标签；返回删除行数（0 = 标签不存在） */
  async deleteTag(promptId: string, name: string): Promise<number> {
    const rows = await this.db
      .delete(promptVersionTags)
      .where(and(eq(promptVersionTags.promptId, promptId), eq(promptVersionTags.name, name)))
      .returning({ id: promptVersionTags.id });
    return rows.length;
  }

  /** 节点下所有 Prompt 的所有版本（012 版本平权：应用表单候选不过滤标签） */
  async findNodeVersionCandidates(node: string): Promise<NodeVersionCandidateRow[]> {
    return await this.db
      .select({
        promptId: prompts.id,
        promptName: prompts.name,
        versionId: promptVersions.id,
        version: promptVersions.version,
        compileStatus: promptVersions.compileStatus,
        body: promptVersions.body,
        node: prompts.node,
        createdAt: promptVersions.createdAt,
      })
      .from(promptVersions)
      .innerJoin(prompts, eq(promptVersions.promptId, prompts.id))
      .where(eq(prompts.node, node))
      .orderBy(asc(prompts.name), desc(promptVersions.version));
  }

  // 删除 prompt（versions/tags 由 FK ON DELETE CASCADE 级联；被应用配置 RESTRICT 时抛 23503）
  async deletePrompt(id: string): Promise<void> {
    await this.db.delete(prompts).where(eq(prompts.id, id));
  }
}
