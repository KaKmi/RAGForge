import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import {
  extractVars,
  type CreatePromptRequest,
  type CreatePromptVersionRequest,
  type Prompt,
  type PromptListQuery,
  type PromptListResponse,
  type PromptVersion,
} from "@codecrush/contracts";
import { PromptsRepository, type PromptListRow } from "./prompts.repository";
import type { PromptVersionRow } from "./schema";

@Injectable()
export class PromptsService {
  constructor(private readonly repo: PromptsRepository) {}

  async list(q: PromptListQuery): Promise<PromptListResponse> {
    const { items, total } = await this.repo.findPrompts(q);
    return {
      items: items.map(toPrompt),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  async get(id: string): Promise<Prompt> {
    const r = await this.repo.findPromptById(id);
    if (!r) throw new NotFoundException(`prompt ${id} not found`);
    return toPrompt(r);
  }

  // 建 Prompt + 自动起 v1 draft（无 tx，对齐 users.service 范式；测试支配——见 dev-ledger concerns）
  async createPrompt(req: CreatePromptRequest, actorEmail: string): Promise<Prompt> {
    const p = await this.repo.insertPrompt({
      name: req.name,
      node: req.node,
      currentVersionId: null,
      updatedBy: actorEmail,
    });
    await this.repo.insertVersion({
      promptId: p.id,
      version: 1,
      body: req.body,
      variables: extractVars(req.body),
      note: req.note,
      author: actorEmail,
      status: "draft",
    });
    // 重新查带聚合的行（currentVersionNumber:null + versionCount:1），保证返回契约完整
    const row = await this.repo.findPromptById(p.id);
    if (!row) throw new Error(`createPrompt: prompt ${p.id} vanished after insert`);
    return toPrompt(row);
  }

  async listVersions(promptId: string): Promise<PromptVersion[]> {
    await this.get(promptId);
    return (await this.repo.findVersions(promptId)).map(toVersion);
  }

  // 出新版本：max+1 + unique(promptId,version) 兜底；撞号 retry 一次（D8）
  async createVersion(
    promptId: string,
    req: CreatePromptVersionRequest,
    actorEmail: string,
  ): Promise<PromptVersion> {
    await this.get(promptId);
    for (let attempt = 0; attempt < 2; attempt++) {
      const next =
        (await this.repo.findVersions(promptId)).reduce((m, v) => Math.max(m, v.version), 0) + 1;
      try {
        const row = await this.repo.insertVersion({
          promptId,
          version: next,
          body: req.body,
          variables: extractVars(req.body),
          note: req.note,
          author: actorEmail,
          status: "draft",
        });
        return toVersion(row);
      } catch (e) {
        if (isUniqueViolation(e) && attempt === 0) continue;
        if (isUniqueViolation(e)) throw new ConflictException("version 冲突，重试失败");
        throw e;
      }
    }
    throw new ConflictException("version 冲突，重试失败");
  }

  // 发布/回滚统一入口：draft→prod（publish）/ archived→prod（rollback）。
  // 已 prod → 409（D15）；版本不存在或不属于该 prompt → 404。
  async promote(
    promptId: string,
    versionId: string,
    actorEmail: string,
  ): Promise<PromptVersion> {
    const v = await this.repo.findVersionById(versionId);
    if (!v || v.promptId !== promptId) {
      throw new NotFoundException(`version ${versionId} not found`);
    }
    if (v.status === "prod") throw new ConflictException("该版本已是生产版本");
    return toVersion(await this.repo.publishVersion(promptId, versionId, actorEmail));
  }

  // 删除 prompt：仅草稿（currentVersionId === null）可删；已启用（线上运行中）→ 409
  async delete(promptId: string): Promise<void> {
    const r = await this.repo.findPromptById(promptId);
    if (!r) throw new NotFoundException(`prompt ${promptId} not found`);
    if (r.currentVersionId !== null) {
      throw new ConflictException("已启用的 Prompt 不可删除，请先停用");
    }
    await this.repo.deletePrompt(promptId);
  }
}

function toPrompt(row: PromptListRow): Prompt {
  return {
    id: row.id,
    name: row.name,
    node: row.node as Prompt["node"],
    currentVersionId: row.currentVersionId ?? null,
    currentVersionNumber: row.currentVersionNumber,
    versionCount: row.versionCount,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

function toVersion(row: PromptVersionRow): PromptVersion {
  return {
    id: row.id,
    promptId: row.promptId,
    version: row.version,
    body: row.body,
    variables: row.variables,
    note: row.note ?? undefined,
    author: row.author,
    status: row.status as PromptVersion["status"],
    createdAt: row.createdAt.toISOString(),
  };
}

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code: string }).code === "23505"
  );
}
