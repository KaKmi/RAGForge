import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  CreateKnowledgeBaseRequest,
  KnowledgeBase,
  UpdateKnowledgeBaseRequest,
} from "@codecrush/contracts";
import { KnowledgeBasesRepository } from "./knowledge-bases.repository";
import { DocumentsRepository } from "../documents/documents.repository";
import { ChunksRepository } from "../chunks/chunks.repository";
import { ModelsService } from "../models/models.service";
import { KbRebuildService } from "../ingestion/kb-rebuild.service";
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
  ) {}

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

    const row = await this.repo.insert({
      name: req.name,
      desc: req.desc,
      // M4.1 迁移期占位：契约层已保证 chunkTemplate 或 processingProfile 至少其一，
      // Task 7 用 profile 反查映射替换此块（profile-only 请求反写 chunkTemplate）。
      chunkTemplate: req.chunkTemplate ?? "general",
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
    const changingTemplate =
      req.chunkTemplate !== undefined && req.chunkTemplate !== existing.chunkTemplate;

    // 重建中再次改分块模板 → 409（buildingVersion 非空即在建）。
    if (changingTemplate && existing.buildingVersion !== null) {
      throw new ConflictException(`knowledge base ${id} 正在重建中，请等待完成后再修改分块模板`);
    }

    const row = await this.repo.update(id, {
      name: req.name,
      desc: req.desc,
      chunkTemplate: req.chunkTemplate,
    });
    if (!row) throw new NotFoundException(`knowledge base ${id} not found`);

    // 改模板 → 触发异步蓝绿重建（startRebuild 只入队，不阻塞 HTTP），
    // 重建将 kb 置 building；重新读取以返回 building 态。
    if (changingTemplate) {
      await this.kbRebuild.startRebuild(id);
      return this.withCounts(await this.mustFind(id));
    }
    return this.withCounts(row);
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
      // M4.1：迁移期占位 null，Task 7 接线 default_profile_* 列后填真实值。
      processingProfileId: null,
      processingProfileVersion: null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
