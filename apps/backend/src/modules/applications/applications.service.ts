import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  Application,
  ApplicationChatResult,
  ApplicationConfigFields,
  ApplicationConfigVersion,
  ApplicationDetail,
  CreateApplicationConfigVersionRequest,
  CreateApplicationRequest,
  PromptUsageEntry,
  UpdateApplicationRequest,
} from "@codecrush/contracts";
import { KnowledgeBasesService } from "../knowledge-bases/knowledge-bases.service";
import { ModelsService } from "../models/models.service";
import { PromptsService } from "../prompts/prompts.service";
import { ApplicationsRepository, type ApplicationListRow } from "./applications.repository";
import type { ApplicationConfigVersionRow } from "./schema";

const nodes = ["rewrite", "intent", "reply", "fallback"] as const;

@Injectable()
export class ApplicationsService {
  constructor(
    private readonly repo: ApplicationsRepository,
    private readonly knowledgeBases: KnowledgeBasesService,
    private readonly models: ModelsService,
    private readonly prompts: PromptsService,
  ) {}
  async list(): Promise<Application[]> {
    return Promise.all((await this.repo.findApplications()).map((r) => this.toApplication(r)));
  }
  async getDetail(id: string): Promise<ApplicationDetail> {
    const app = await this.mustFind(id);
    const versions = await this.repo.findVersions(id);
    const kbIds = await this.repo.findKbIdsByVersionIds(versions.map((v) => v.id));
    return {
      ...(await this.toApplication(app)),
      versions: await Promise.all(versions.map((v) => this.toVersion(v, kbIds.get(v.id) ?? []))),
    };
  }
  async create(req: CreateApplicationRequest, actor: string): Promise<ApplicationDetail> {
    if (await this.repo.findBySlug(req.slug))
      throw new ConflictException(`slug ${req.slug} 已存在`);
    if (await this.repo.findByName(req.name))
      throw new ConflictException(`name ${req.name} 已存在`);
    const kbIds = await this.validate(req.config);
    let application;
    try {
      ({ application } = await this.repo.createApplicationWithV1(
        {
          slug: req.slug,
          name: req.name,
          description: req.description,
          enabled: true,
          productionConfigVersionId: null,
          createdBy: actor,
          updatedBy: actor,
        },
        {
          version: 1,
          configSchemaVersion: 1,
          ...this.columns(req.config),
          note: null,
          createdBy: actor,
        },
        kbIds,
      ));
    } catch (e) {
      if (pgCode(e) === "23505") throw new ConflictException("slug 或 name 已存在");
      throw e;
    }
    return this.getDetail(application.id);
  }
  async updateBase(id: string, req: UpdateApplicationRequest, actor: string): Promise<Application> {
    await this.mustFind(id);
    if (req.name) {
      const same = await this.repo.findByName(req.name);
      if (same && same.id !== id) throw new ConflictException(`name ${req.name} 已存在`);
    }
    const patch: UpdateApplicationRequest = {};
    if (req.name !== undefined) patch.name = req.name;
    if (req.description !== undefined) patch.description = req.description;
    if (req.enabled !== undefined) patch.enabled = req.enabled;
    let updated;
    try {
      updated = await this.repo.updateBase(id, { ...patch, updatedBy: actor });
    } catch (e) {
      if (pgCode(e) === "23505") throw new ConflictException("name 已存在");
      throw e;
    }
    if (!updated) throw new NotFoundException(`application ${id} not found`);
    return this.toApplication(await this.mustFind(id));
  }
  async delete(id: string): Promise<void> {
    if ((await this.repo.deleteApplication(id)) === 0)
      throw new NotFoundException(`application ${id} not found`);
  }
  async listVersions(id: string): Promise<ApplicationConfigVersion[]> {
    await this.mustFind(id);
    const versions = await this.repo.findVersions(id);
    const kbIds = await this.repo.findKbIdsByVersionIds(versions.map((v) => v.id));
    return Promise.all(versions.map((v) => this.toVersion(v, kbIds.get(v.id) ?? [])));
  }
  async getVersion(id: string, versionId: string): Promise<ApplicationConfigVersion> {
    const v = await this.mustFindVersion(id, versionId);
    return this.toVersion(v);
  }
  async createVersion(
    id: string,
    req: CreateApplicationConfigVersionRequest,
    actor: string,
  ): Promise<ApplicationConfigVersion> {
    await this.mustFind(id);
    const kbIds = await this.validate(req.config);
    for (let attempt = 0; attempt < 2; attempt++)
      try {
        const versions = await this.repo.findVersions(id);
        const v = await this.repo.insertVersion(
          {
            applicationId: id,
            version: (versions[0]?.version ?? 0) + 1,
            configSchemaVersion: 1,
            ...this.columns(req.config),
            note: req.note ?? null,
            createdBy: actor,
          },
          kbIds,
          actor,
        );
        return this.toVersion(v, kbIds);
      } catch (e) {
        if (attempt === 0 && pgCode(e) === "23505") continue;
        if (pgCode(e) === "23505") throw new ConflictException("版本号冲突");
        throw e;
      }
    throw new ConflictException("版本号冲突");
  }
  async tryVersionChat(id: string, versionId: string): Promise<ApplicationChatResult> {
    await this.mustFindVersion(id, versionId);
    return { mode: "unavailable", reason: "pending_orchestration" };
  }
  async promptUsage(promptId: string): Promise<PromptUsageEntry[]> {
    const versions = await this.prompts.listVersions(promptId);
    const byId = new Map(versions.map((v) => [v.id, v.version]));
    return (await this.repo.findPromptUsage([...byId.keys()])).map((r) => ({
      promptVersionId: r.prompt_version_id,
      promptVersion: byId.get(r.prompt_version_id)!,
      applicationId: r.application_id,
      applicationName: r.application_name,
      node: r.node as PromptUsageEntry["node"],
      configVersion: r.config_version,
    }));
  }
  private async validate(config: ApplicationConfigFields): Promise<string[]> {
    const kbIds = [...new Set(config.kbIds)];
    const kbs = await this.knowledgeBases.findByIds(kbIds);
    if (kbs.length !== kbIds.length) throw new NotFoundException("knowledge base not found");
    if (new Set(kbs.map((k) => k.embeddingModelId)).size > 1)
      throw new BadRequestException("知识库 embedding 模型不一致");
    for (const node of nodes) {
      const n = config.nodes[node];
      const model = await this.models.get(n.modelId);
      if (model.type !== "llm" || !model.enabled)
        throw new BadRequestException(`${node} model 必须是启用的 llm`);
      const meta = await this.prompts.getVersionMeta(n.promptVersionId);
      if (!meta) throw new NotFoundException(`prompt version ${n.promptVersionId} not found`);
      if (meta.node !== node)
        throw new BadRequestException(`prompt version node 与 ${node} 不匹配`);
    }
    if (config.retrieval.rerankModelId) {
      const model = await this.models.get(config.retrieval.rerankModelId);
      if (model.type !== "rerank" || !model.enabled)
        throw new BadRequestException("rerank model 必须是启用的 rerank");
    }
    return kbIds;
  }
  private columns(config: ApplicationConfigFields) {
    const n = config.nodes;
    const params = Object.fromEntries(
      nodes.map((key) => [
        key,
        { freedom: n[key].freedom, temperature: n[key].temperature, topP: n[key].topP },
      ]),
    );
    return {
      promptRewriteVersionId: n.rewrite.promptVersionId,
      promptIntentVersionId: n.intent.promptVersionId,
      promptReplyVersionId: n.reply.promptVersionId,
      promptFallbackVersionId: n.fallback.promptVersionId,
      rewriteModelId: n.rewrite.modelId,
      intentModelId: n.intent.modelId,
      replyModelId: n.reply.modelId,
      fallbackModelId: n.fallback.modelId,
      rerankModelId: config.retrieval.rerankModelId ?? null,
      nodeParams: params as ApplicationConfigVersionRow["nodeParams"],
      retrievalParams: config.retrieval,
      fallbackParams: config.fallback,
    };
  }
  private async mustFind(id: string) {
    const row = await this.repo.findApplicationById(id);
    if (!row) throw new NotFoundException(`application ${id} not found`);
    return row;
  }
  private async mustFindVersion(applicationId: string, id: string) {
    const row = await this.repo.findVersionById(id);
    if (!row || row.applicationId !== applicationId)
      throw new NotFoundException(`version ${id} not found`);
    return row;
  }
  private async toApplication(row: ApplicationListRow): Promise<Application> {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      enabled: row.enabled,
      productionVersion: row.productionVersion,
      productionConfigVersionId: row.productionConfigVersionId,
      latestVersion: row.latestVersion,
      versionCount: row.versionCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      updatedBy: row.updatedBy,
      createdBy: row.createdBy,
    };
  }
  private async toVersion(
    row: ApplicationConfigVersionRow,
    knownKbIds?: string[],
  ): Promise<ApplicationConfigVersion> {
    const kbIds = knownKbIds ?? (await this.repo.findVersionKbIds(row.id));
    const node = (key: (typeof nodes)[number], promptVersionId: string, modelId: string) => ({
      ...row.nodeParams[key],
      promptVersionId,
      modelId,
    });
    return {
      id: row.id,
      applicationId: row.applicationId,
      version: row.version,
      configSchemaVersion: 1,
      kbIds,
      nodes: {
        rewrite: node("rewrite", row.promptRewriteVersionId, row.rewriteModelId),
        intent: node("intent", row.promptIntentVersionId, row.intentModelId),
        reply: node("reply", row.promptReplyVersionId, row.replyModelId),
        fallback: node("fallback", row.promptFallbackVersionId, row.fallbackModelId),
      },
      retrieval: row.retrievalParams,
      fallback: row.fallbackParams,
      note: row.note ?? undefined,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
function pgCode(error: unknown) {
  if (typeof error === "object" && error && "code" in error) {
    return (error as { code: string }).code;
  }
  const cause = error instanceof Error ? error.cause : undefined;
  return typeof cause === "object" && cause && "code" in cause
    ? (cause as { code: string }).code
    : undefined;
}
