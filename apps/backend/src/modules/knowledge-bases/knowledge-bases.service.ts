import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  ChunkTemplate,
  CreateKnowledgeBaseRequest,
  KnowledgeBase,
  ProcessingProfileRef,
  UpdateKnowledgeBaseRequest,
} from "@codecrush/contracts";
import { KnowledgeBasesRepository } from "./knowledge-bases.repository";
import { DocumentsRepository } from "../documents/documents.repository";
import { ChunksRepository } from "../chunks/chunks.repository";
import { ModelsService } from "../models/models.service";
import { KbRebuildService, type RebuildScope } from "../ingestion/kb-rebuild.service";
import { PROFILE_REGISTRY } from "../ingestion/ingestion.constants";
import type { ProfileRegistry } from "../ingestion/profiles/profile-registry";
import { chunkTemplateToProfileRef } from "../ingestion/profiles/profile-registry";
import type { KnowledgeBaseRow } from "./schema";

// 平台统一向量维度：探针在创建时强校验（010 全局约束）。
const EMBED_DIMENSION = 1024;

@Injectable()
export class KnowledgeBasesService {
  constructor(
    private readonly repo: KnowledgeBasesRepository,
    private readonly docsRepo: DocumentsRepository,
    private readonly chunksRepo: ChunksRepository,
    private readonly models: ModelsService,
    private readonly kbRebuild: KbRebuildService,
    @Inject(PROFILE_REGISTRY) private readonly registry: ProfileRegistry,
  ) {}

  /** Cross-domain read port for application configuration validation. */
  async findByIds(ids: string[]) {
    return this.repo.findByIds(ids);
  }

  // 迁移窗口解析：新前端送 processingProfile*，旧前端送 chunkTemplate；返回校验过的 ref + 反查的 chunkTemplate。
  // 二者互斥/成对由契约层保证；此处 registry 校验存在性（未注册 → 400）。
  private resolveProfile(
    profileId: string | undefined,
    profileVersion: number | undefined,
    chunkTemplate: ChunkTemplate | undefined,
  ): { ref: ProcessingProfileRef; chunkTemplate: ChunkTemplate } {
    const ref: ProcessingProfileRef = profileId
      ? { profileId, profileVersion: profileVersion! }
      : chunkTemplateToProfileRef(chunkTemplate!);
    const def = this.registry.get(ref.profileId, ref.profileVersion);
    if (!def) {
      throw new BadRequestException(
        `[PROFILE_VERSION_UNAVAILABLE] 处理方案 ${ref.profileId}@${ref.profileVersion} 不可用`,
      );
    }
    // 显式给 profile 时 chunkTemplate 恒由方案的 chunker 反写（不采信调用方同传的 chunkTemplate），
    // 保证 defaultProfile* 与 chunkTemplate 始终一致（契约已拒绝二者同传，此处为纵深防御）。
    return {
      ref,
      chunkTemplate: (profileId
        ? def.chunker.id
        : (chunkTemplate ?? def.chunker.id)) as ChunkTemplate,
    };
  }

  async list(): Promise<KnowledgeBase[]> {
    const rows = await this.repo.find();
    const ids = rows.map((r) => r.id);
    // 两次分组查询填充全部卡片计数（文档数按 kb，切片数按 kb 的 activeVersion 挑行），避免 N+1。
    const [docCounts, chunkCounts] = await Promise.all([
      this.docsRepo.countByKbs(ids),
      this.chunksRepo.countByKbVersions(ids),
    ]);
    const docMap = new Map(docCounts.map((c) => [c.kbId, c.count]));
    const chunkMap = new Map(chunkCounts.map((c) => [`${c.kbId}:${c.version}`, c.count]));
    return rows.map((r) =>
      this.toKnowledgeBase(
        r,
        docMap.get(r.id) ?? 0,
        chunkMap.get(`${r.id}:${r.activeVersion}`) ?? 0,
      ),
    );
  }

  async get(id: string): Promise<KnowledgeBase> {
    return this.withCounts(await this.mustFind(id));
  }

  async create(req: CreateKnowledgeBaseRequest): Promise<KnowledgeBase> {
    // 名称查重：service 层显式 409，不依赖 DB unique 约束裸抛 500。
    const existing = await this.repo.findByName(req.name);
    if (existing) {
      throw new ConflictException(`knowledge base named "${req.name}" already exists`);
    }

    // models 域不校验消费方语义（type/enabled），由 host 裁定为本域责任。
    // models.get 对不存在的 id 抛 404，满足「已存在」要求。
    const model = await this.models.get(req.embeddingModelId);
    if (model.type !== "embedding" || !model.enabled) {
      throw new BadRequestException(
        "embeddingModelId 必须指向已启用（enabled）的 embedding 类型模型",
      );
    }

    // 创建时真实探针：调 embedTexts 单条探针文本，确认模型可用且输出 1024 维。
    // embedTexts 内部对非 1024 维会抛普通 Error（协议适配器），此处统一转 400；
    // 同时显式校验维度，兜住返回非 1024 维但未抛错的实现。
    await this.probeEmbeddingDimension(req.embeddingModelId);

    // 迁移窗口：profile 或 chunkTemplate 至少其一（契约层保证）→ 双写 defaultProfile* + chunkTemplate。
    const { ref, chunkTemplate } = this.resolveProfile(
      req.processingProfileId,
      req.processingProfileVersion,
      req.chunkTemplate,
    );
    const row = await this.repo.insert({
      name: req.name,
      desc: req.desc,
      chunkTemplate,
      defaultProfileId: ref.profileId,
      defaultProfileVersion: ref.profileVersion,
      embeddingModelId: req.embeddingModelId,
    });
    return this.toKnowledgeBase(row);
  }

  async update(id: string, req: UpdateKnowledgeBaseRequest): Promise<KnowledgeBase> {
    // embeddingModelId 创建后锁定：显式 400（防御性——契约层已不含该字段）。
    if ((req as Record<string, unknown>).embeddingModelId !== undefined) {
      throw new BadRequestException("embeddingModelId 创建后不可更改");
    }

    const existing = await this.mustFind(id);

    // 新前端改默认 Profile：更新 defaultProfile* + 反写 chunkTemplate，但【不】触发重建
    // （010 §选择5：改默认只影响未来 Run；应用到旧文档走显式 rebuild 端点）。
    if (req.processingProfileId !== undefined) {
      const changingProfile =
        req.processingProfileId !== existing.defaultProfileId ||
        req.processingProfileVersion !== existing.defaultProfileVersion;
      if (changingProfile && existing.buildingVersion !== null) {
        throw new ConflictException(`knowledge base ${id} 正在重建中，请等待完成后再修改处理方案`);
      }
      const { ref, chunkTemplate } = this.resolveProfile(
        req.processingProfileId,
        req.processingProfileVersion,
        undefined,
      );
      const row = await this.repo.update(id, {
        name: req.name,
        desc: req.desc,
        chunkTemplate,
        defaultProfileId: ref.profileId,
        defaultProfileVersion: ref.profileVersion,
      });
      if (!row) throw new NotFoundException(`knowledge base ${id} not found`);
      return this.withCounts(row);
    }

    // 旧前端只改 chunkTemplate：双写 defaultProfile*（反查映射）+ 变更时自动全库重建（保留旧行为）。
    const changingTemplate =
      req.chunkTemplate !== undefined && req.chunkTemplate !== existing.chunkTemplate;
    if (changingTemplate && existing.buildingVersion !== null) {
      throw new ConflictException(`knowledge base ${id} 正在重建中，请等待完成后再修改分块模板`);
    }

    const templatePatch =
      req.chunkTemplate !== undefined
        ? {
            chunkTemplate: req.chunkTemplate,
            defaultProfileId: chunkTemplateToProfileRef(req.chunkTemplate).profileId,
            defaultProfileVersion: chunkTemplateToProfileRef(req.chunkTemplate).profileVersion,
          }
        : {};
    const row = await this.repo.update(id, {
      name: req.name,
      desc: req.desc,
      ...templatePatch,
    });
    if (!row) throw new NotFoundException(`knowledge base ${id} not found`);

    // 改模板 → 触发异步蓝绿重建（startRebuild 只入队，不阻塞 HTTP），重建将 kb 置 building。
    if (changingTemplate) {
      await this.kbRebuild.startRebuild(id, "all");
      return this.withCounts(await this.mustFind(id));
    }
    return this.withCounts(row);
  }

  // 显式重建端点：把 KB 下（范围内）文档以新版本重新入库。scope='inherited' 只重建继承默认方案的文档。
  async rebuild(id: string, scope: RebuildScope): Promise<KnowledgeBase> {
    await this.mustFind(id);
    await this.kbRebuild.startRebuild(id, scope);
    return this.withCounts(await this.mustFind(id));
  }

  private async probeEmbeddingDimension(modelId: string): Promise<void> {
    let vectors: number[][];
    try {
      vectors = await this.models.embedTexts(modelId, ["probe"]);
    } catch (err) {
      throw new BadRequestException(
        `embedding 模型探针失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const dim = vectors[0]?.length ?? 0;
    if (dim !== EMBED_DIMENSION) {
      throw new BadRequestException(
        `embedding 模型输出 ${dim} 维，平台要求统一 ${EMBED_DIMENSION} 维`,
      );
    }
  }

  private async mustFind(id: string): Promise<KnowledgeBaseRow> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundException(`knowledge base ${id} not found`);
    return row;
  }

  // 单库响应的真实计数（get/update 路径）；列表路径走 list() 的分组批量查询。
  private async withCounts(row: KnowledgeBaseRow): Promise<KnowledgeBase> {
    const [docCounts, chunkCounts] = await Promise.all([
      this.docsRepo.countByKbs([row.id]),
      this.chunksRepo.countByKbVersions([row.id]),
    ]);
    const chunksCount = chunkCounts.find((c) => c.version === row.activeVersion)?.count ?? 0;
    return this.toKnowledgeBase(row, docCounts[0]?.count ?? 0, chunksCount);
  }

  // progress 仍为可选缺省：重建进度百分比留待后续（UI 对缺省回退 0）。
  private toKnowledgeBase(row: KnowledgeBaseRow, docsCount = 0, chunksCount = 0): KnowledgeBase {
    return {
      id: row.id,
      name: row.name,
      desc: row.desc,
      chunkTemplate: row.chunkTemplate as "general" | "qa",
      embeddingModelId: row.embeddingModelId,
      docsCount,
      chunksCount,
      status: row.status as "ready" | "building" | "failed",
      activeVersion: row.activeVersion,
      buildingVersion: row.buildingVersion,
      processingProfileId: row.defaultProfileId,
      processingProfileVersion: row.defaultProfileVersion,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
