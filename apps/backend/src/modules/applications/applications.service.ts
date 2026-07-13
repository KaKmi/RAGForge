import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type {
  Application,
  ApplicationChatResult,
  ApplicationConfigFields,
  ApplicationConfigVersion,
  ApplicationDetail,
  ApplicationTag,
  CreateApplicationConfigVersionRequest,
  CreateApplicationRequest,
  PromptUsageEntry,
  ReleaseCheck,
  ReleaseCheckIssue,
  ResolvedApplicationConfig,
  UpdateApplicationRequest,
} from "@codecrush/contracts";
import { KnowledgeBasesService } from "../knowledge-bases/knowledge-bases.service";
import { ModelsService } from "../models/models.service";
import { NodeContractRegistry } from "../node-runtime/contracts/registry";
import { PromptsService } from "../prompts/prompts.service";
import { RELEASE_CHECK_JOB, RELEASE_CHECK_QUEUE } from "../../platform/queue/queue.constants";
import type { Queue } from "../../platform/queue/queue.port";
import { ApplicationsRepository, type ApplicationListRow } from "./applications.repository";
import { computeFingerprint, type FingerprintInput } from "./fingerprint";
import type { ApplicationConfigVersionRow, ReleaseCheckRow } from "./schema";

const APPLICATION_TAG_CAP = 20;
const PRODUCTION_TAG = "production";
const APPLICATION_TAG_RESERVED = [PRODUCTION_TAG, "v"];
const nodes = ["rewrite", "intent", "reply", "fallback"] as const;
type NodeKey = (typeof nodes)[number];

// 四节点 → 配置版本行的 (prompt 版本列, 模型列) 映射
const NODE_COLUMNS: Record<NodeKey, { prompt: keyof ApplicationConfigVersionRow; model: keyof ApplicationConfigVersionRow }> = {
  rewrite: { prompt: "promptRewriteVersionId", model: "rewriteModelId" },
  intent: { prompt: "promptIntentVersionId", model: "intentModelId" },
  reply: { prompt: "promptReplyVersionId", model: "replyModelId" },
  fallback: { prompt: "promptFallbackVersionId", model: "fallbackModelId" },
};

type ModelMeta = Awaited<ReturnType<ModelsService["get"]>> | null;
interface ReleaseContext {
  kbIds: string[];
  kbRows: Awaited<ReturnType<KnowledgeBasesService["findByIds"]>>;
  promptMetas: Map<NodeKey, Awaited<ReturnType<PromptsService["getVersionMeta"]>>>;
  modelMetas: Map<NodeKey, ModelMeta>;
  rerank: ModelMeta;
}

@Injectable()
export class ApplicationsService {
  private readonly logger = new Logger(ApplicationsService.name);

  constructor(
    private readonly repo: ApplicationsRepository,
    private readonly knowledgeBases: KnowledgeBasesService,
    private readonly models: ModelsService,
    private readonly prompts: PromptsService,
    @Inject(RELEASE_CHECK_QUEUE) private readonly releaseQueue: Queue,
  ) {}
  async list(): Promise<Application[]> {
    const rows = await this.repo.findApplications();
    const tagsByApp = await this.repo.findTagNamesByAppIds(rows.map((r) => r.id));
    return rows.map((r) => this.toApplication(r, tagsByApp.get(r.id) ?? []));
  }
  async getDetail(id: string): Promise<ApplicationDetail> {
    const app = await this.mustFind(id);
    const [versions, tagsByApp] = await Promise.all([
      this.repo.findVersions(id),
      this.repo.findTagNamesByAppIds([id]),
    ]);
    const kbIds = await this.repo.findKbIdsByVersionIds(versions.map((v) => v.id));
    return {
      ...this.toApplication(app, tagsByApp.get(id) ?? []),
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
    const row = await this.mustFind(id);
    const tagsByApp = await this.repo.findTagNamesByAppIds([id]);
    return this.toApplication(row, tagsByApp.get(id) ?? []);
  }

  // —— M7b 自定义命名标签（production 走 §S5 受门禁 CAS，不经此路径）——
  async moveTag(
    id: string,
    name: string,
    versionId: string,
    actor: string,
  ): Promise<ApplicationTag[]> {
    await this.mustFind(id);
    // review P2-1：service 二次防（直接调用方）必须先归一小写——否则 "Production" 绕过
    // 保留字检查、tagExists（比 lower）漏判，upsert 落 name='Production'（lower='production'）
    // = 事实上的 production 标签行，破坏红线不变量 1。HTTP 路径已被契约 refine 归一拦下，
    // 此处是 in-process 调用方的真实防线。
    const tag = name.toLowerCase();
    if (APPLICATION_TAG_RESERVED.includes(tag))
      throw new BadRequestException(`${name} 是保留字，不能作自定义标签`);
    const v = await this.repo.findVersionById(versionId);
    if (!v || v.applicationId !== id)
      throw new NotFoundException(`version ${versionId} 不存在或不属于该应用`);
    // 20 上限只对新名；移动已存在标签（upsert 到别版本）不占额度
    if (
      !(await this.repo.tagExists(id, tag)) &&
      (await this.repo.countTags(id)) >= APPLICATION_TAG_CAP
    )
      throw new UnprocessableEntityException(`自定义标签数已达上限 ${APPLICATION_TAG_CAP}`);
    try {
      await this.repo.upsertTag(id, versionId, tag, actor);
    } catch (e) {
      // 复合 FK 兜底并发窗口（预检后版本被删/换主）→ 23503 转 404
      if (pgCode(e) === "23503")
        throw new NotFoundException(`version ${versionId} 不存在或不属于该应用`);
      throw e;
    }
    return this.repo.findTagsWithVersion(id);
  }

  async removeTag(id: string, rawName: string): Promise<void> {
    await this.mustFind(id);
    if ((await this.repo.deleteTag(id, rawName.toLowerCase())) === 0)
      throw new NotFoundException(`标签 ${rawName} 不存在`);
  }

  async listTags(id: string): Promise<ApplicationTag[]> {
    await this.mustFind(id);
    return this.repo.findTagsWithVersion(id);
  }

  // —— M7b ReleaseCheck（静态门禁同步 + 异步真实 NodeRuntime 预演入队）——
  async startReleaseCheck(id: string, versionId: string, actor: string): Promise<ReleaseCheck> {
    await this.mustFind(id);
    const version = await this.mustFindVersion(id, versionId);
    const ctx = await this.buildReleaseContext(version);
    const issues = this.staticGate(version, ctx);
    // 静态失败 422（携 issues）——不入队，current production 不受影响
    if (issues.length > 0)
      throw new UnprocessableEntityException({ message: "发布静态门禁未通过", issues });
    const fingerprint = computeFingerprint(this.fingerprintInput(version, ctx));
    const row = await this.repo.insertReleaseCheck({
      applicationId: id,
      configVersionId: versionId,
      configFingerprint: fingerprint,
      createdBy: actor,
    });
    // 幂等：singletonKey=checkId；retryLimit=1（review P2-2：worker 崩溃需重投一次才能恢复，
    // 终态跳过守卫保证重投已完成的 check 是 no-op，不会重复计费）
    await this.releaseQueue.publish(
      RELEASE_CHECK_JOB,
      { checkId: row.id },
      { singletonKey: row.id, retryLimit: 1 },
    );
    return this.toReleaseCheck(row);
  }

  async getReleaseCheck(id: string, checkId: string): Promise<ReleaseCheck> {
    await this.mustFind(id);
    const row = await this.repo.findReleaseCheckById(checkId);
    if (!row || row.applicationId !== id)
      throw new NotFoundException(`release check ${checkId} not found`);
    return this.toReleaseCheck(row);
  }

  // —— M7b production 受门禁 CAS 上线/回滚/下线（009 §上线请求）——
  async publishProduction(
    id: string,
    req: { versionId: string; releaseCheckId: string; expectedProductionVersionId: string | null },
    actor: string,
  ): Promise<Application> {
    await this.mustFind(id);
    const version = await this.mustFindVersion(id, req.versionId);
    const check = await this.repo.findReleaseCheckById(req.releaseCheckId);
    // 门禁四连：归属 → passed → 未过期 → fingerprint 与当前依赖重算一致
    if (!check || check.applicationId !== id || check.configVersionId !== req.versionId)
      throw new NotFoundException(`release check ${req.releaseCheckId} 不存在或不属于该版本`);
    if (check.status !== "passed")
      throw new UnprocessableEntityException(`release check 状态为 ${check.status}，需要 passed`);
    if (!check.expiresAt || check.expiresAt.getTime() <= Date.now())
      throw new ConflictException("release check 已过期，请重新检查");
    const currentFingerprint = await this.computeVersionFingerprint(version);
    if (currentFingerprint !== check.configFingerprint)
      throw new ConflictException("依赖已变化（fingerprint 不匹配），请重新检查后上线");

    const cas = await this.repo.casProduction(id, req.versionId, req.expectedProductionVersionId, actor);
    if (cas === "ownership_fail")
      throw new BadRequestException(`version ${req.versionId} 不属于该应用`);
    if (cas === "cas_conflict")
      throw new ConflictException("production 指针已被并发修改，请刷新后重新确认");
    // 审计（控制面事件，009 Observability；当前无独立审计存储，结构化日志承载）。
    // review P3：带上 prev 指针——回滚场景最关键的审计字段。
    this.logger.log(
      `application.production.changed app=${id} version=${req.versionId} prev=${req.expectedProductionVersionId ?? "null"} check=${req.releaseCheckId} by=${actor}`,
    );
    const row = await this.mustFind(id);
    const tagsByApp = await this.repo.findTagNamesByAppIds([id]);
    return this.toApplication(row, tagsByApp.get(id) ?? []);
  }

  async unpublishProduction(
    id: string,
    expectedProductionVersionId: string | null,
    actor: string,
  ): Promise<Application> {
    await this.mustFind(id);
    const cas = await this.repo.clearProduction(id, expectedProductionVersionId, actor);
    if (cas === "cas_conflict")
      throw new ConflictException("production 指针已被并发修改，请刷新后重新确认");
    this.logger.log(`application.production.cleared app=${id} by=${actor}`);
    const row = await this.mustFind(id);
    const tagsByApp = await this.repo.findTagNamesByAppIds([id]);
    return this.toApplication(row, tagsByApp.get(id) ?? []);
  }

  // —— M7b 运行时解析（009 §运行时解析：拒绝序 deleted → disabled → 目标缺失 → resolved）——

  /** 匿名公开解析：只读 production 指针。M7b 仅作端口（匿名 chat 端点随 M8）。 */
  async resolvePublic(idOrSlug: string): Promise<ResolvedApplicationConfig> {
    const app = await this.findVisibleAppByIdOrSlug(idOrSlug); // deleted/missing → 404
    if (!app.enabled) throw new ForbiddenException("应用已停用"); // disabled
    if (!app.productionConfigVersionId) throw new NotFoundException("应用未上线"); // 目标缺失
    return this.buildResolvedConfig(app, app.productionConfigVersionId, false);
  }

  /** 管理员带标签解析（Q1：非 production 标签仅管理员可达；controller 全局 JWT 即管理员面）。 */
  async resolveByTag(
    idOrSlug: string,
    tag: string | undefined,
    actor: string,
  ): Promise<ResolvedApplicationConfig> {
    const app = await this.findVisibleAppByIdOrSlug(idOrSlug);
    if (!app.enabled) throw new ForbiddenException("应用已停用");
    let versionId: string;
    if (!tag || tag.toLowerCase() === PRODUCTION_TAG) {
      if (!app.productionConfigVersionId) throw new NotFoundException("应用未上线");
      versionId = app.productionConfigVersionId;
    } else {
      const hit = (await this.repo.findTagsWithVersion(app.id)).find(
        (t) => t.name === tag.toLowerCase(),
      );
      if (!hit) throw new NotFoundException(`标签 ${tag} 不存在`);
      versionId = hit.versionId;
    }
    this.logger.log(`application.resolve app=${app.id} tag=${tag ?? PRODUCTION_TAG} by=${actor}`);
    return this.buildResolvedConfig(app, versionId, true);
  }

  /** 管理员显式版本解析（对话测试），preview=true。 */
  async resolveForTest(
    applicationId: string,
    configVersionId: string,
    _actor: string,
  ): Promise<ResolvedApplicationConfig> {
    const app = await this.mustFind(applicationId);
    const v = await this.mustFindVersion(applicationId, configVersionId);
    return this.buildResolvedConfig(app, v.id, true);
  }

  private async findVisibleAppByIdOrSlug(idOrSlug: string): Promise<ApplicationListRow> {
    const byId = await this.repo.findApplicationById(idOrSlug); // 已过滤软删
    if (byId) return byId;
    const bySlug = await this.repo.findBySlug(idOrSlug); // D8：未过滤软删，此处显式判
    if (!bySlug || bySlug.deletedAt) throw new NotFoundException(`应用 ${idOrSlug} 不存在`);
    const row = await this.repo.findApplicationById(bySlug.id);
    if (!row) throw new NotFoundException(`应用 ${idOrSlug} 不存在`);
    return row;
  }

  private async buildResolvedConfig(
    app: ApplicationListRow,
    versionId: string,
    preview: boolean,
  ): Promise<ResolvedApplicationConfig> {
    const v = await this.repo.findVersionById(versionId);
    if (!v || v.applicationId !== app.id) throw new NotFoundException("目标配置版本不存在");
    // review（refactor）：四节点互不依赖，并行取代顺序 await——resolvePublic 热路径受益最大
    const [kbIds, nodeEntries] = await Promise.all([
      this.repo.findVersionKbIds(v.id),
      Promise.all(
        nodes.map(async (node) => {
          const promptVersionId = v[NODE_COLUMNS[node].prompt] as string;
          const exec = await this.prompts.getVersionExecutable(promptVersionId);
          // FK RESTRICT 保护下不应发生；发生即数据完整性破坏，快速失败
          if (!exec)
            throw new UnprocessableEntityException(
              `${node} 的 PromptVersion ${promptVersionId} 不存在`,
            );
          const p = v.nodeParams[node];
          return [
            node,
            {
              promptVersionId,
              promptBody: exec.body,
              contractVersion: exec.contractVersion,
              modelId: v[NODE_COLUMNS[node].model] as string,
              freedom: p.freedom,
              temperature: p.temperature,
              topP: p.topP,
            },
          ] as const;
        }),
      ),
    ]);
    const nodesOut = Object.fromEntries(nodeEntries) as ResolvedApplicationConfig["nodes"];
    return {
      applicationId: app.id,
      slug: app.slug,
      name: app.name, // M9 W1：agent 名快照来源（写侧落 gen_ai.agent.name）
      configVersionId: v.id,
      version: v.version,
      kbIds,
      nodes: nodesOut,
      retrieval: v.retrievalParams,
      fallback: v.fallbackParams,
      preview,
    };
  }

  /** 同一函数供上线校验重算 fingerprint（S5）——保证 start 与 publish 用同一算法。 */
  async computeVersionFingerprint(version: ApplicationConfigVersionRow): Promise<string> {
    return computeFingerprint(this.fingerprintInput(version, await this.buildReleaseContext(version)));
  }

  private async buildReleaseContext(version: ApplicationConfigVersionRow): Promise<ReleaseContext> {
    // review（refactor）：四节点的 prompt/model 元数据、KB id 集合、rerank 元数据互不依赖，
    // 并行取代顺序 await（kbRows 依赖 kbIds，保留其后置的必要顺序）。
    const [kbIds, nodeMetas, rerank] = await Promise.all([
      this.repo.findVersionKbIds(version.id),
      Promise.all(
        nodes.map(async (node) => {
          const [promptMeta, modelMeta] = await Promise.all([
            this.prompts.getVersionMeta(version[NODE_COLUMNS[node].prompt] as string),
            this.safeGetModel(version[NODE_COLUMNS[node].model] as string),
          ]);
          return [node, promptMeta, modelMeta] as const;
        }),
      ),
      version.rerankModelId ? this.safeGetModel(version.rerankModelId) : Promise.resolve(null),
    ]);
    const kbRows = await this.knowledgeBases.findByIds(kbIds);
    const promptMetas = new Map<NodeKey, Awaited<ReturnType<PromptsService["getVersionMeta"]>>>(
      nodeMetas.map(([node, promptMeta]) => [node, promptMeta]),
    );
    const modelMetas = new Map<NodeKey, ModelMeta>(
      nodeMetas.map(([node, , modelMeta]) => [node, modelMeta]),
    );
    return { kbIds, kbRows, promptMetas, modelMetas, rerank };
  }

  private async safeGetModel(modelId: string): Promise<ModelMeta> {
    try {
      return await this.models.get(modelId);
    } catch {
      return null; // 缺失/失败在静态门禁里作为 issue，不抛断请求
    }
  }

  // 上线门禁第一层：静态检查（只读 DB + 纯逻辑，不调用模型）——7 项，返回空数组=通过
  private staticGate(version: ApplicationConfigVersionRow, ctx: ReleaseContext): ReleaseCheckIssue[] {
    const issues: ReleaseCheckIssue[] = [];
    // 1. ≥1 KB 且 embedding 模型一致
    if (ctx.kbIds.length === 0) issues.push({ code: "NO_KB", message: "至少需要一个知识库" });
    else if (new Set(ctx.kbRows.map((k) => k.embeddingModelId)).size > 1)
      issues.push({ code: "KB_EMBEDDING_MISMATCH", message: "知识库 embedding 模型不一致" });
    // 2/3/7. 四 PromptVersion 存在 + 节点归属 + 编译无错 + NodeRuntime 支持 contract
    for (const node of nodes) {
      const promptVersionId = version[NODE_COLUMNS[node].prompt] as string;
      const meta = ctx.promptMetas.get(node);
      if (!meta) {
        issues.push({ code: "PROMPT_VERSION_MISSING", node, promptVersionId, message: `${node} 的 PromptVersion 不存在` });
        continue;
      }
      if (meta.node !== node)
        issues.push({ code: "PROMPT_NODE_MISMATCH", node, promptVersionId, message: `PromptVersion 归属 ${meta.node}，与 ${node} 不匹配` });
      if (meta.compileStatus === "has_errors")
        issues.push({ code: "PROMPT_COMPILE_ERROR", node, promptVersionId, action: "OPEN_PROMPT_TRY_RUN", message: `${node} 的 Prompt 存在编译错误` });
      try {
        NodeContractRegistry.resolve(node, meta.contractVersion);
      } catch {
        issues.push({ code: "CONTRACT_UNSUPPORTED", node, promptVersionId, message: `NodeRuntime 不支持 ${node} 的 contractVersion ${meta.contractVersion}` });
      }
    }
    // 4. 四 LLM 模型存在 + 启用 + 类型
    for (const node of nodes) {
      const model = ctx.modelMetas.get(node);
      if (!model) issues.push({ code: "MODEL_MISSING", node, message: `${node} 模型不存在` });
      else if (model.type !== "llm" || !model.enabled)
        issues.push({ code: "MODEL_INVALID", node, message: `${node} 模型必须是启用的 llm` });
    }
    // 5. rerank 开启则模型合法
    if (version.rerankModelId) {
      if (!ctx.rerank) issues.push({ code: "RERANK_MISSING", message: "rerank 模型不存在" });
      else if (ctx.rerank.type !== "rerank" || !ctx.rerank.enabled)
        issues.push({ code: "RERANK_INVALID", message: "rerank 模型必须是启用的 rerank" });
    }
    // 6. 值域（对存量版本再查一遍，防旧版本越界）
    const r = version.retrievalParams;
    if (r.topN > r.topK) issues.push({ code: "TOPN_GT_TOPK", message: "topN 不能大于 topK" });
    if (r.vectorWeight < 0 || r.vectorWeight > 1)
      issues.push({ code: "VECTOR_WEIGHT_RANGE", message: "vectorWeight 越界 [0,1]" });
    if (r.rerankThreshold != null && (r.rerankThreshold < 0 || r.rerankThreshold > 1))
      issues.push({ code: "RERANK_THRESHOLD_RANGE", message: "rerankThreshold 越界 [0,1]" });
    for (const node of nodes) {
      const p = version.nodeParams[node];
      if (p.temperature < 0 || p.temperature > 2)
        issues.push({ code: "TEMPERATURE_RANGE", node, message: `${node} temperature 越界 [0,2]` });
      if (p.topP < 0 || p.topP > 1)
        issues.push({ code: "TOPP_RANGE", node, message: `${node} topP 越界 [0,1]` });
    }
    return issues;
  }

  private fingerprintInput(version: ApplicationConfigVersionRow, ctx: ReleaseContext): FingerprintInput {
    return {
      configVersionId: version.id,
      prompts: nodes.map((node) => ({
        node,
        promptVersionId: version[NODE_COLUMNS[node].prompt] as string,
        contractVersion: ctx.promptMetas.get(node)?.contractVersion ?? 0,
      })),
      models: nodes.map((node) => ({
        node,
        modelId: version[NODE_COLUMNS[node].model] as string,
        // buildReleaseContext 对四节点必填，但 Map.get 类型为 ModelMeta|undefined——coalesce 满足类型
        providerRevision: this.modelRevision(ctx.modelMetas.get(node) ?? null),
      })),
      rerankModelId: version.rerankModelId ?? null,
      rerankProviderRevision: version.rerankModelId ? this.modelRevision(ctx.rerank) : null,
      nodeParams: version.nodeParams,
      retrievalParams: version.retrievalParams,
      fallbackParams: version.fallbackParams,
      kbs: ctx.kbRows.map((k) => ({
        kbId: k.id,
        activeVersion: k.activeVersion,
        intentKey: k.intentKey ?? null,
      })),
    };
  }

  // provider revision = 模型配置相关字段（比 updated_at 更语义、且不越界读 models schema）
  private modelRevision(m: ModelMeta): string {
    if (!m) return "missing";
    return JSON.stringify({
      // review P2-1：上游真实模型身份是 deploymentId ?? name（protocols/types.ts:28）——
      // deploymentId 为空时改 name 即换模型，必须翻转 fingerprint；哈希 coalesced 值
      // 同时避免"仅展示改名"（deploymentId 已设）造成的假 409。
      identity: m.deploymentId ?? m.name,
      params: m.params,
      baseUrl: m.baseUrl,
      deploymentId: m.deploymentId,
      enabled: m.enabled,
      protocol: m.protocol,
      type: m.type,
    });
  }

  private toReleaseCheck(row: ReleaseCheckRow): ReleaseCheck {
    return {
      id: row.id,
      applicationId: row.applicationId,
      configVersionId: row.configVersionId,
      configFingerprint: row.configFingerprint,
      status: row.status,
      issues: row.issues,
      sampleSummary: row.sampleSummary,
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    };
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
    await this.mustFind(id); // review P3-1：软删应用的版本详情也应 404（与 detail/列表一致）
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
    await this.mustFind(id); // review P3-1：软删应用不可测试
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
  private toApplication(row: ApplicationListRow, tags: string[]): Application {
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
      tags,
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
