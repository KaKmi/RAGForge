import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  compilePromptBody,
  extractVars,
  NODE_CONTRACT_VERSION,
  type CompileResult,
  type CreatePromptRequest,
  type CreatePromptVersionRequest,
  type Prompt,
  type PromptDetail,
  type PromptListQuery,
  type PromptListResponse,
  type PromptNode,
  type PromptNodeVersionCandidate,
  type PromptTag,
  type PromptVersion,
} from "@codecrush/contracts";
import {
  PromptsRepository,
  type PromptListRow,
  type TagRow,
} from "./prompts.repository";
import type { PromptVersionRow } from "./schema";

@Injectable()
export class PromptsService {
  constructor(private readonly repo: PromptsRepository) {}

  async list(q: PromptListQuery): Promise<PromptListResponse> {
    const { items, total } = await this.repo.findPrompts(q);
    // 批量取最新版本标签（一次查询防 N+1）
    const latestIds = items.map((r) => r.latestVersionId).filter((id): id is string => !!id);
    const tagRows = await this.repo.findTagsByVersionIds(latestIds);
    const tagsByVersion = groupTags(tagRows);
    return {
      items: items.map((r) => toPrompt(r, tagsByVersion.get(r.latestVersionId ?? "") ?? [])),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  /** 详情 = 摘要 + 全部历史版本（降序）+ 各版本标签（历史抽屉一次拿全） */
  async getDetail(id: string): Promise<PromptDetail> {
    const row = await this.repo.findPromptById(id);
    if (!row) throw new NotFoundException(`prompt ${id} not found`);
    const [versions, tagRows] = await Promise.all([
      this.repo.findVersions(id),
      this.repo.findTagsByPromptId(id),
    ]);
    const tagsByVersion = groupTags(tagRows);
    const node = row.node as PromptNode;
    return {
      ...toPrompt(row, tagsByVersion.get(row.latestVersionId ?? "") ?? []),
      versions: versions.map((v) => toVersion(v, node, tagsByVersion.get(v.id) ?? [])),
    };
  }

  // 012：新建只填 name/node，事务内创建空 body v1（无标签）；撞名 → 409
  async createPrompt(req: CreatePromptRequest, actorEmail: string): Promise<PromptDetail> {
    const compiled = compilePromptBody("", req.node);
    try {
      const { prompt } = await this.repo.createPromptWithV1(
        { name: req.name, node: req.node, updatedBy: actorEmail },
        {
          version: 1,
          body: "",
          variables: [],
          contractVersion: NODE_CONTRACT_VERSION,
          compileStatus: compiled.status,
          compileErrors: compiled.issues,
          author: actorEmail,
          // 兼容窗口：旧 status 列 NOT NULL，显式写 draft（Story 4 随列删除）
          status: "draft",
        },
      );
      return await this.getDetail(prompt.id);
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException(`名称 ${req.name} 已存在`);
      throw e;
    }
  }

  async listVersions(promptId: string): Promise<PromptVersion[]> {
    const prompt = await this.mustFindPrompt(promptId);
    const [versions, tagRows] = await Promise.all([
      this.repo.findVersions(promptId),
      this.repo.findTagsByPromptId(promptId),
    ]);
    const tagsByVersion = groupTags(tagRows);
    const node = prompt.node as PromptNode;
    return versions.map((v) => toVersion(v, node, tagsByVersion.get(v.id) ?? []));
  }

  // 保存总是创建不可变新版本：body 允许空、错误允许保存，服务端编译结果是最终事实。
  // sourceVersionId 仅用于沿用来源版本的 contractVersion（「创建副本」），不得跨 Prompt。
  async createVersion(
    promptId: string,
    req: CreatePromptVersionRequest,
    actorEmail: string,
  ): Promise<PromptVersion> {
    const prompt = await this.mustFindPrompt(promptId);
    const node = prompt.node as PromptNode;

    let contractVersion = NODE_CONTRACT_VERSION;
    if (req.sourceVersionId) {
      const source = await this.repo.findVersionById(req.sourceVersionId);
      if (!source || source.promptId !== promptId) {
        throw new BadRequestException("sourceVersionId 不存在或不属于该 Prompt");
      }
      contractVersion = source.contractVersion;
    }

    const compiled = compilePromptBody(req.body, node);
    // 版本号 max+1，撞 unique(promptId,version) retry 一次（并发写兜底）
    for (let attempt = 0; attempt < 2; attempt++) {
      const latest = await this.repo.findVersions(promptId);
      const next = (latest[0]?.version ?? 0) + 1;
      try {
        const row = await this.repo.insertVersion({
          promptId,
          version: next,
          body: req.body,
          variables: extractVars(req.body),
          contractVersion,
          compileStatus: compiled.status,
          compileErrors: compiled.issues,
          note: req.note,
          author: actorEmail,
          // 兼容窗口：显式写 draft（Story 4 随列删除）
          status: "draft",
        });
        await this.repo.touchPrompt(promptId, actorEmail);
        return toVersion(row, node, []);
      } catch (e) {
        if (isUniqueViolation(e) && attempt === 0) continue;
        if (isUniqueViolation(e)) throw new ConflictException("版本号冲突，重试失败");
        throw e;
      }
    }
    throw new ConflictException("版本号冲突，重试失败");
  }

  /** 标签排他移动：production 与自定义标签走同一写路径（012 §3，不做任何门禁） */
  async moveTag(
    promptId: string,
    name: string,
    versionId: string,
    actorEmail: string,
  ): Promise<PromptTag[]> {
    await this.mustFindPrompt(promptId);
    const version = await this.repo.findVersionById(versionId);
    if (!version || version.promptId !== promptId) {
      throw new NotFoundException(`version ${versionId} 不存在或不属于该 Prompt`);
    }
    // 复合 FK 仍兜底并发窗口（预检后版本被删的竞态 → 23503 转 404）
    try {
      await this.repo.upsertTag(promptId, versionId, name, actorEmail);
    } catch (e) {
      if (isForeignKeyViolation(e)) {
        throw new NotFoundException(`version ${versionId} 不存在或不属于该 Prompt`);
      }
      throw e;
    }
    return await this.repo.findTagsWithVersion(promptId);
  }

  /** 摘除标签（大小写不敏感：存储已归一小写，入参同样归一） */
  async removeTag(promptId: string, rawName: string): Promise<void> {
    await this.mustFindPrompt(promptId);
    const deleted = await this.repo.deleteTag(promptId, rawName.toLowerCase());
    if (deleted === 0) throw new NotFoundException(`标签 ${rawName} 不存在`);
  }

  /** 节点下所有具体版本（012 版本平权：不过滤标签，标签仅作前端排序/高亮信号） */
  async nodeVersionCandidates(node: PromptNode): Promise<PromptNodeVersionCandidate[]> {
    const rows = await this.repo.findNodeVersionCandidates(node);
    const tagRows = await this.repo.findTagsByVersionIds(rows.map((r) => r.versionId));
    const tagsByVersion = groupTags(tagRows);
    return rows.map((r) => ({
      promptId: r.promptId,
      promptName: r.promptName,
      versionId: r.versionId,
      version: r.version,
      tags: tagsByVersion.get(r.versionId) ?? [],
      compileStatus: normalizeCompile(r.compileStatus, r.body, r.node as PromptNode).status,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // 012：删除仅依赖 FK 事实（应用配置 RESTRICT），不再有「已发布不可删」语义
  async delete(promptId: string): Promise<void> {
    await this.mustFindPrompt(promptId);
    try {
      await this.repo.deletePrompt(promptId);
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        throw new ConflictException(
          `prompt ${promptId} 的某个版本仍被 Agent 配置引用，无法删除`,
        );
      }
      throw err;
    }
  }

  // 供跨域（agents）调用：给定 prompt_version id，反查所属 prompt/node/版本号
  async getVersionMeta(
    versionId: string,
  ): Promise<{ promptId: string; node: string; version: number } | null> {
    const version = await this.repo.findVersionById(versionId);
    if (!version) return null;
    const prompt = await this.repo.findPromptById(version.promptId);
    if (!prompt) return null;
    return { promptId: version.promptId, node: prompt.node, version: version.version };
  }

  private async mustFindPrompt(id: string): Promise<PromptListRow> {
    const row = await this.repo.findPromptById(id);
    if (!row) throw new NotFoundException(`prompt ${id} not found`);
    return row;
  }
}

function groupTags(rows: TagRow[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const list = map.get(r.promptVersionId) ?? [];
    list.push(r.name);
    map.set(r.promptVersionId, list);
  }
  return map;
}

function toPrompt(row: PromptListRow, latestTags: string[]): Prompt {
  // v1 随建随生（事务保证），latestVersion 为空意味着数据完整性被破坏——快速失败
  if (row.latestVersion == null) {
    throw new Error(`prompt ${row.id} 没有任何版本（invariant 破坏：v1 应随建随生）`);
  }
  return {
    id: row.id,
    name: row.name,
    node: row.node as Prompt["node"],
    latestVersion: row.latestVersion,
    versionCount: row.versionCount,
    tags: latestTags,
    variables: row.latestVariables ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

// 兼容窗口防御：backfill 前的旧行 compile_status 可能为空——用共享编译器按需重算（纯函数，代价可忽略）
function normalizeCompile(
  status: string | null,
  body: string,
  node: PromptNode,
): CompileResult {
  if (status === "ok" || status === "has_errors" || status === "has_warnings") {
    return { status, issues: [] };
  }
  return compilePromptBody(body, node);
}

function toVersion(row: PromptVersionRow, node: PromptNode, tags: string[]): PromptVersion {
  const fallback =
    row.compileStatus == null ? compilePromptBody(row.body, node) : undefined;
  return {
    id: row.id,
    promptId: row.promptId,
    version: row.version,
    body: row.body,
    variables: row.variables,
    note: row.note ?? undefined,
    author: row.author,
    contractVersion: row.contractVersion,
    compileStatus: (fallback?.status ?? row.compileStatus) as PromptVersion["compileStatus"],
    compileErrors: fallback?.issues ?? row.compileErrors ?? [],
    tags,
    createdAt: row.createdAt.toISOString(),
  };
}

function isUniqueViolation(e: unknown): boolean {
  return hasPgCode(e, "23505");
}

function isForeignKeyViolation(e: unknown): boolean {
  return hasPgCode(e, "23503");
}

// drizzle 把底层 pg 错误包在 e.cause 里（models.service.ts 实测模式）；
// 直连 pg/execute 路径则在顶层 code——两处都查（peer review 采纳项）
function hasPgCode(e: unknown, code: string): boolean {
  const top =
    typeof e === "object" && e !== null && "code" in e && (e as { code: unknown }).code;
  if (top === code) return true;
  const cause = e instanceof Error ? e.cause : undefined;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code: unknown }).code === code
  );
}
