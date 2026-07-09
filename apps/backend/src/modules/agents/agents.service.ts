import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  Agent,
  AgentConfigVersion,
  CreateAgentConfigVersionRequest,
  CreateAgentRequest,
  UpdateAgentRequest,
} from "@codecrush/contracts";
import { AgentsRepository, type AgentListRow } from "./agents.repository";
import type { AgentRow, AgentConfigVersionRow } from "./schema";
import { KnowledgeBasesRepository } from "../knowledge-bases/knowledge-bases.repository";
import { ModelsService } from "../models/models.service";
import { PromptsService } from "../prompts/prompts.service";

// create（v1）与 createVersion 共用的版本化配置字段形状
type ConfigFields = Omit<CreateAgentRequest, "name" | "desc">;

const PROMPT_FIELD_NODE = [
  ["promptRewriteVerId", "rewrite"],
  ["promptIntentVerId", "intent"],
  ["promptReplyVerId", "reply"],
  ["promptFallbackVerId", "fallback"],
] as const;

@Injectable()
export class AgentsService {
  constructor(
    private readonly repo: AgentsRepository,
    private readonly kbRepo: KnowledgeBasesRepository,
    private readonly models: ModelsService,
    private readonly prompts: PromptsService,
  ) {}

  async list(): Promise<Agent[]> {
    const rows = await this.repo.findAgents();
    return Promise.all(rows.map((r) => this.toAgentFromListRow(r)));
  }

  async get(id: string): Promise<Agent> {
    return this.toAgentFromListRow(await this.mustFindAgent(id));
  }

  // 建 Agent + v1（008 数据流程图 ①）：校验 → 单事务落库，v1 直接 published + evalStatus=exempt（决策 4）
  async create(req: CreateAgentRequest, actorEmail: string): Promise<Agent> {
    // 名称查重：service 层显式 409（对齐 knowledge-bases.service create 的既有模式）
    const existing = await this.repo.findAgentByName(req.name);
    if (existing) throw new ConflictException(`agent named "${req.name}" already exists`);
    const kbIds = await this.validateConfigFields(req);
    const { agent, version } = await this.repo.createAgentWithV1(
      {
        name: req.name,
        desc: req.desc,
        enabled: true,
        currentVersionId: null,
        updatedBy: actorEmail,
      },
      {
        version: 1,
        status: "published",
        ...this.toVersionColumns(req),
        evalStatus: "exempt",
        note: null,
        createdBy: actorEmail,
        publishedBy: actorEmail,
        publishedAt: new Date(),
      },
      kbIds,
    );
    return this.toAgent(agent, version, kbIds);
  }

  // 编辑收窄：仅 name/desc/enabled（008 决策 3）。契约层 strictObject 已拒绝未知键，
  // 此处显式白名单拾取作为纵深防御（非 HTTP 调用路径同样只透传这三个字段）。
  async updateBase(id: string, req: UpdateAgentRequest, actorEmail: string): Promise<Agent> {
    await this.mustFindAgent(id);
    const patch: Partial<Pick<AgentRow, "name" | "desc" | "enabled">> = {};
    if (req.name !== undefined) patch.name = req.name;
    if (req.desc !== undefined) patch.desc = req.desc;
    if (req.enabled !== undefined) patch.enabled = req.enabled;
    // 改名撞其他 Agent 的唯一名：预检转 409（对齐 create 路径，不让 unique violation 裸奔 500）
    if (patch.name !== undefined) {
      const sameName = await this.repo.findAgentByName(patch.name);
      if (sameName && sameName.id !== id) {
        throw new ConflictException(`agent named "${patch.name}" already exists`);
      }
    }
    const row = await this.repo.updateAgentBase(id, { ...patch, updatedBy: actorEmail });
    if (!row) throw new NotFoundException(`agent ${id} not found`);
    return this.toAgentFromListRow(await this.mustFindAgent(id));
  }

  async listVersions(agentId: string): Promise<AgentConfigVersion[]> {
    await this.mustFindAgent(agentId);
    const rows = await this.repo.findVersions(agentId);
    return Promise.all(rows.map((r) => this.toVersionWithKbs(r)));
  }

  // 新建草稿配置版本（008 数据流程图 ②），可重新绑定知识库（决策 1）
  async createVersion(
    agentId: string,
    req: CreateAgentConfigVersionRequest,
    actorEmail: string,
  ): Promise<AgentConfigVersion> {
    await this.mustFindAgent(agentId);
    const kbIds = await this.validateConfigFields(req);
    const existing = await this.repo.findVersions(agentId);
    const nextVersion = existing.reduce((m, v) => Math.max(m, v.version), 0) + 1;
    const version = await this.repo.insertDraftVersion(
      {
        agentId,
        version: nextVersion,
        status: "draft",
        ...this.toVersionColumns(req),
        evalStatus: "not_run",
        note: req.note ?? null,
        createdBy: actorEmail,
        publishedBy: null,
        publishedAt: null,
      },
      kbIds,
    );
    return this.toVersionWithKbs(version, kbIds);
  }

  // Eval stub（008 决策 2：硬编码通过，evalPassRate 恒 null——不编造数字）
  async evalRun(agentId: string, versionId: string): Promise<AgentConfigVersion> {
    const v = await this.mustFindVersion(agentId, versionId);
    if (v.status !== "draft") throw new ConflictException("只能对草稿版本发起 Eval");
    const updated = await this.repo.updateVersionEval(versionId, {
      evalStatus: "passed",
      evalRunAt: new Date(),
      evalPassRate: null,
      evalSummary: { stub: true, message: "M11 评测系统上线前占位，默认标记通过" },
    });
    return this.toVersionWithKbs(updated);
  }

  // 发布：draft → published，先过 Eval 门槛（008 Invariant 2）
  async publish(
    agentId: string,
    versionId: string,
    actorEmail: string,
  ): Promise<AgentConfigVersion> {
    const v = await this.mustFindVersion(agentId, versionId);
    if (v.status !== "draft") throw new ConflictException("只有草稿版本可以发布");
    if (v.evalStatus !== "passed" && v.evalStatus !== "exempt") {
      throw new ConflictException("未通过 Eval 门槛，无法发布");
    }
    return this.toVersionWithKbs(await this.repo.promote(agentId, versionId, actorEmail));
  }

  // 回滚：archived → published。目标版本历史上已过门槛，不重新校验（008 Invariant 2）
  async rollback(
    agentId: string,
    versionId: string,
    actorEmail: string,
  ): Promise<AgentConfigVersion> {
    const v = await this.mustFindVersion(agentId, versionId);
    if (v.status !== "archived") throw new ConflictException("只能回滚到已归档版本");
    return this.toVersionWithKbs(await this.repo.promote(agentId, versionId, actorEmail));
  }

  // === 校验（create 与 createVersion 共用）：knowledge base embedding 一致性（集合级、顺序无关，
  // 008「知识库 Embedding 一致性后端校验」）+ 模型 type/enabled + Prompt node 归属。
  // 返回去重后的 kbIds（重复 id 不去重会撞 agent_config_version_kbs 复合主键裸 500）===
  private async validateConfigFields(req: ConfigFields): Promise<string[]> {
    const kbIds = [...new Set(req.kbIds)];
    const kbs = await this.kbRepo.findByIds(kbIds);
    const foundIds = new Set(kbs.map((k) => k.id));
    const missing = kbIds.find((id) => !foundIds.has(id));
    if (missing) throw new NotFoundException(`knowledge base ${missing} not found`);
    const distinctEmbed = new Set(kbs.map((k) => k.embeddingModelId));
    if (distinctEmbed.size > 1) {
      // 基准取 kbIds[0] 仅用于错误文案措辞对齐前端展示，校验本身是集合判断
      const base = kbs.find((k) => k.id === req.kbIds[0]);
      const conflict = kbs.find((k) => k.embeddingModelId !== base?.embeddingModelId);
      throw new BadRequestException(
        `「${conflict?.name}」使用与已选知识库不一致的向量模型，无法同时绑定`,
      );
    }

    await this.validateModelRef(req.genModelId, "llm", "genModelId");
    if (req.lightModelId) await this.validateModelRef(req.lightModelId, "llm", "lightModelId");
    if (req.rerankModelId) {
      await this.validateModelRef(req.rerankModelId, "rerank", "rerankModelId");
    }

    for (const [field, expectedNode] of PROMPT_FIELD_NODE) {
      const versionId = req[field];
      const meta = await this.prompts.getVersionMeta(versionId);
      if (!meta) throw new NotFoundException(`prompt version ${versionId} not found`);
      if (meta.node !== expectedNode) {
        throw new BadRequestException(
          `${field} 指向的版本所属节点为 ${meta.node}，与期望的 ${expectedNode} 不一致`,
        );
      }
    }
    return kbIds;
  }

  private async validateModelRef(
    modelId: string,
    expectedType: "llm" | "rerank",
    field: string,
  ): Promise<void> {
    // models.get 对不存在的 id 抛 404（对齐 knowledge-bases.service 的既有用法）
    const model = await this.models.get(modelId);
    if (model.type !== expectedType || !model.enabled) {
      throw new BadRequestException(
        `${field} 必须指向已启用（enabled）的 ${expectedType} 类型模型`,
      );
    }
  }

  private async mustFindAgent(id: string): Promise<AgentListRow> {
    const row = await this.repo.findAgentById(id);
    if (!row) throw new NotFoundException(`agent ${id} not found`);
    return row;
  }

  private async mustFindVersion(
    agentId: string,
    versionId: string,
  ): Promise<AgentConfigVersionRow> {
    const v = await this.repo.findVersionById(versionId);
    if (!v || v.agentId !== agentId) {
      throw new NotFoundException(`version ${versionId} not found`);
    }
    return v;
  }

  // 请求字段 → 版本表列（create/createVersion 共用的映射）
  private toVersionColumns(req: ConfigFields) {
    return {
      genModelId: req.genModelId,
      lightModelId: req.lightModelId ?? null,
      rerankModelId: req.rerankModelId ?? null,
      promptRewriteVerId: req.promptRewriteVerId,
      promptIntentVerId: req.promptIntentVerId,
      promptReplyVerId: req.promptReplyVerId,
      promptFallbackVerId: req.promptFallbackVerId,
      nodeParams: req.nodeParams,
      topK: req.topK,
      topN: req.topN,
      threshold: req.threshold,
      multiRecall: req.multiRecall,
      vecWeight: req.vecWeight ?? null,
      fallbackHuman: req.fallbackHuman,
      evalRunAt: null,
      evalPassRate: null,
      evalSummary: null,
    };
  }

  // status 不落库，按 currentVersionId/enabled 派生（008 数据模型，同 prompts.toPrompt 心智）
  private deriveStatus(row: {
    currentVersionId: string | null;
    enabled: boolean;
  }): Agent["status"] {
    if (row.currentVersionId === null) return "draft";
    return row.enabled ? "active" : "archived";
  }

  private async toAgentFromListRow(row: AgentListRow): Promise<Agent> {
    const versionRow = row.currentVersionId
      ? await this.repo.findVersionById(row.currentVersionId)
      : undefined;
    const currentVersion = versionRow ? await this.toVersionWithKbs(versionRow) : null;
    return {
      id: row.id,
      name: row.name,
      desc: row.desc,
      enabled: row.enabled,
      status: this.deriveStatus(row),
      currentVersion,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      updatedBy: row.updatedBy,
    };
  }

  private async toAgent(
    agent: AgentRow,
    version: AgentConfigVersionRow,
    kbIds: string[],
  ): Promise<Agent> {
    return {
      id: agent.id,
      name: agent.name,
      desc: agent.desc,
      enabled: agent.enabled,
      status: this.deriveStatus(agent),
      currentVersion: await this.toVersionWithKbs(version, kbIds),
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
      updatedBy: agent.updatedBy,
    };
  }

  private async toVersionWithKbs(
    row: AgentConfigVersionRow,
    knownKbIds?: string[],
  ): Promise<AgentConfigVersion> {
    const kbIds = knownKbIds ?? (await this.repo.findVersionKbIds(row.id));
    return {
      id: row.id,
      agentId: row.agentId,
      version: row.version,
      status: row.status as AgentConfigVersion["status"],
      kbIds,
      genModelId: row.genModelId,
      lightModelId: row.lightModelId ?? undefined,
      rerankModelId: row.rerankModelId ?? undefined,
      promptRewriteVerId: row.promptRewriteVerId,
      promptIntentVerId: row.promptIntentVerId,
      promptReplyVerId: row.promptReplyVerId,
      promptFallbackVerId: row.promptFallbackVerId,
      nodeParams: row.nodeParams,
      topK: row.topK,
      topN: row.topN,
      threshold: row.threshold,
      multiRecall: row.multiRecall,
      vecWeight: row.vecWeight ?? undefined,
      fallbackHuman: row.fallbackHuman,
      evalStatus: row.evalStatus as AgentConfigVersion["evalStatus"],
      evalRunAt: row.evalRunAt ? row.evalRunAt.toISOString() : null,
      evalPassRate: row.evalPassRate,
      note: row.note ?? undefined,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      publishedBy: row.publishedBy,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    };
  }
}
