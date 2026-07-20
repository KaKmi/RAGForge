import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  CreateGapItemRequest,
  CreateGapItemResponse,
  GapCluster,
  GapItem,
  GapListQuery,
  GapListResponse,
  GapSummary,
} from "@codecrush/contracts";
import { EvaluationsRepository } from "../evaluations/evaluations.repository";
import { ModelsService } from "../models/models.service";
import { VECTOR_DIMENSION } from "../../platform/persistence/pgvector-type";
import { FREQ_WINDOW_DAYS, type GapClusterStatus, type GapRootCause } from "./gap.constants";
import { assignToCluster, recomputeRootCause } from "./gap-ingest";
import {
  GapItemsMovedConcurrentlyError,
  GapsRepository,
  type GapClusterListRow,
} from "./gaps.repository";
import type { GapItemRow } from "./schema";

/**
 * 缺口簇的状态机与簇操作（021 决策 A）。
 *
 * 合法迁移**穷举成常量表**，非法迁移一律 400。写成表而不是散在各方法里的 if：
 * B2b 要加四个态（drafting/reviewing/filled/verified），届时改这一张表 + DB 的 CHECK 即可，
 * 不必翻遍所有分支去找漏网的迁移。
 *
 * ⚠️ `routed_retrieval --ignore--> ignored` 是**有意放行**的（V15）：一个没有出口的状态是死态，
 * 「已转检索优化」之后发现判错了，必须还能忽略掉，否则那行永远堵在列表里。
 */
const TRANSITIONS = {
  ignore: { from: ["pending", "routed_retrieval"], to: "ignored" },
  reopen: { from: ["ignored"], to: "pending" },
  routeRetrieval: { from: ["pending"], to: "routed_retrieval" },
} as const satisfies Record<string, { from: readonly GapClusterStatus[]; to: GapClusterStatus }>;

export type GapTransition = keyof typeof TRANSITIONS;

function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function toNumberOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

@Injectable()
export class GapsService {
  constructor(
    private readonly repo: GapsRepository,
    private readonly evaluations: EvaluationsRepository,
    private readonly models: ModelsService,
  ) {}

  async list(query: GapListQuery, now = new Date()): Promise<GapListResponse> {
    const windowStart = new Date(now.getTime() - FREQ_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const { items, total } = await this.repo.listClusters(query, windowStart);
    return { items: items.map(toGapCluster), total };
  }

  async summary(): Promise<GapSummary> {
    return this.repo.summary();
  }

  async listItems(clusterId: string, now = new Date()): Promise<GapItem[]> {
    await this.mustFind(clusterId);
    // trace 过期只置灰链接，**不删行、不减频次**（原型 `:377`）——所以过期与否是算出来的，
    // 不是一个会把历史抹掉的清理任务。口径与 ClickHouse 的 30 天 TTL 对齐。
    const ttlCutoff = new Date(now.getTime() - FREQ_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const rows = await this.repo.listItems(clusterId);
    return rows.map((row) => toGapItem(row, ttlCutoff));
  }

  /** 状态迁移。非法迁移抛 400 并说清「从哪到哪不允许」，不静默 no-op。 */
  async transition(id: string, event: GapTransition, now = new Date()): Promise<GapCluster> {
    const cluster = await this.mustFind(id);
    const rule = TRANSITIONS[event];
    if (!(rule.from as readonly string[]).includes(cluster.status)) {
      throw new BadRequestException(
        `illegal transition: ${cluster.status} --${event}--> ${rule.to}（允许的来源：${rule.from.join(" / ")}）`,
      );
    }
    await this.repo.updateStatus(id, rule.to, now);
    return this.mustReadBack(id, now);
  }

  /**
   * 人工改判根因。写 `root_cause_manual`，**worker 永不覆盖它**（Global Constraint 8）；
   * 读取一律 `COALESCE(manual, auto)`，故改判后立刻生效，而 auto 仍留着回答「worker 会怎么判」。
   */
  async setRootCauseManual(
    id: string,
    rootCause: GapRootCause,
    now = new Date(),
  ): Promise<GapCluster> {
    await this.mustFind(id);
    await this.repo.setRootCauseManual(id, rootCause, now);
    return this.mustReadBack(id, now);
  }

  /**
   * 「已进评测集」叠加标志：**不改 status**（原型 `:634` 明令非排他）。
   *
   * ⚠️ 本方法**当前没有 HTTP 路由**：它由 B2b 的「从坏样本生成用例」流程在服务端调用
   * （用例真的落进评测集之后才该打这个标）。单独开一个「我说它进了」的端点是投机——
   * 那会让标志与事实脱钩。db spec 已覆盖它的语义，等 B2b 接上调用方即可。
   */
  async markEnteredEvalSet(id: string, now = new Date()): Promise<GapCluster> {
    await this.mustFind(id);
    await this.repo.markEnteredEvalSet(id, now);
    return this.mustReadBack(id, now);
  }

  /**
   * 拆分：把选中的 item 移出成新簇（原型 `:632`，纠正「聚类把不相干的问题糊到一起」）。
   *
   * 新簇质心 = 被移走向量的**批量均值**（`meanVector`），代表问题 = 被选第一条的问题文本。
   * 两簇 `freq` 按实际成员数重算 ⇒ 拆分前后 item 总数与 freq 之和守恒（AC8）。
   */
  async split(id: string, itemIds: string[], now = new Date()): Promise<{ newClusterId: string }> {
    await this.mustFind(id);
    const moved = await this.assertItemsBelongTo(id, itemIds);
    const remaining = (await this.repo.listItems(id)).length - moved.length;
    if (remaining === 0) {
      // 全选等于「什么都没拆」，却会把源簇软删、再建一个内容相同的新簇 —— 纯粹的身份洗牌，
      // 还会丢掉源簇上的 status / root_cause_manual / entered_eval_set_at。直接拒绝。
      throw new BadRequestException("不能拆走全部成员——那不是拆分，请改用改判或忽略");
    }
    const { targetClusterId } = await this.moveItems(itemIds, id, {
      kind: "new",
      representativeQuestion: moved[0].question,
    }, now);
    // 两簇的成员集都变了，根因必须跟着重算（只写 auto，人工判定不动）。
    await recomputeRootCause(this.repo, id, now);
    await recomputeRootCause(this.repo, targetClusterId, now);
    return { newClusterId: targetClusterId };
  }

  /**
   * 合并：把选中的 item 移进目标簇。源簇被清空则**软删**（留痕，不物理删）。
   * 目标簇的 status / root_cause_manual / entered_eval_set_at 一概不动——那是人对目标簇的判断。
   */
  async merge(
    id: string,
    targetClusterId: string,
    itemIds: string[],
    now = new Date(),
  ): Promise<{ targetClusterId: string; sourceSoftDeleted: boolean }> {
    if (id === targetClusterId) throw new BadRequestException("不能把簇合并到它自己");
    await this.mustFind(id);
    const target = await this.repo.findCluster(targetClusterId);
    if (!target || target.deletedAt !== null) {
      throw new NotFoundException(`目标缺口不存在或已被合并：${targetClusterId}`);
    }
    await this.assertItemsBelongTo(id, itemIds);
    const result = await this.moveItems(
      itemIds,
      id,
      { kind: "existing", clusterId: targetClusterId },
      now,
    );
    await recomputeRootCause(this.repo, targetClusterId, now);
    if (!result.sourceSoftDeleted) await recomputeRootCause(this.repo, id, now);
    return result;
  }

  /**
   * 手动入池（021 决策 B：入口在 Trace 详情 / 屏3，**由前端组合调用**，不产生 `eval-runs → gaps` 反向边）。
   *
   * 归簇走与收集器**同一套**共享实现（`gap-ingest.ts`）。命中既有 item（同一条 trace 已在池中）时
   * 返回 `joinedExisting: true` + 该簇的代表问题与频次，前端据此提示
   * 「已在缺口『…』(×N) 中 · 查看」（原型 `:648`）——**不再插一行**，这正是幂等键选
   * `source_trace_id` 单列的用意。
   */
  async addItem(
    body: CreateGapItemRequest,
    now = new Date(),
  ): Promise<CreateGapItemResponse> {
    const settings = await this.evaluations.getSettings();
    if (!settings.embeddingModelId) {
      throw new BadRequestException("未配置 embedding 模型，无法归簇——请先在在线评测设置里选一个");
    }
    // 聚类键用**原文**，与收集器的 `clusterKeyOf` 逐字一致——那边不做归一化，
    // 这边若归一化，同一个问题自动收进来和人工加进来会得到两个不同的代表问题文本。
    const [embedding] = await this.models.embedTexts(settings.embeddingModelId, [body.question]);
    if (!embedding || embedding.length !== VECTOR_DIMENSION) {
      // 维度不符多半是有人把在线评测的 embedding 模型换成了别的维度。
      // 不拦的话：`cosineSimilarity` 对维度不一致返回 0 ⇒ 必建新簇 ⇒ 往 vector(1024) 列插
      // 一个 1536 维向量 ⇒ pgvector 的原始错误冒成 500。这是配置问题，要 400 说清楚。
      throw new BadRequestException(
        `embedding 模型返回的向量维度不是 ${VECTOR_DIMENSION}（实际 ${embedding?.length ?? 0}），无法入池`,
      );
    }

    /**
     * 未来时间一律拒绝。`freq_30d` 的谓词只有下界（`>= windowStart`）没有上界，
     * 所以一个未来时间戳会**永远**满足它——那一行的「滚动 30 天」就此不再滚动，
     * `traceExpired` 也永远不触发，簇被钉死在屏5 顶部且没有任何线索指回原因。
     * 最可能的来源不是恶意而是**时区 bug**：前端把本地时间当 UTC 序列化（本机 +8h）。
     * 一条还没开始的 trace 不可能被入池，直接 400 比静默接受好。
     */
    if (body.traceStartTime && new Date(body.traceStartTime).getTime() > now.getTime()) {
      throw new BadRequestException(
        "traceStartTime 不能是未来时间——多半是把本地时间当成了 UTC（检查时区序列化）",
      );
    }

    const { clusterId, inserted } = await assignToCluster(
      this.repo,
      body.question,
      {
        source: body.source,
        sourceTraceId: body.sourceTraceId,
        question: body.question,
        // 手动入池不经 rewrite 节点，没有可用的改写结果。标 `false` 是**保守**的默认：
        // 入集守卫会要求人工改写后才能沉淀成 gold，宁可多叫人看一眼。
        rewrittenQuestion: null,
        rewriteResolved: false,
        embedding,
        /**
         * 由**调用方透传**（021 决策 B：入口在 Trace 详情，那一屏手里就有 startTime）。
         * 后端自己去读 trace 是禁止的边（`gaps → traces`），但让前端把已有的值带上不越界。
         * 不带就是 NULL ⇒ 不计入 `freq_30d` 窗口，只计入累计 `freq`——那样屏5 会把一条
         * 人刚刚断言「这是真实流量」的样本显示成 `freq30d 0`（读起来像陈旧流量），
         * 所以入口页应当带上它。
         */
        traceStartTime: body.traceStartTime ? new Date(body.traceStartTime) : null,
        faithfulness: null,
        answerRelevancy: null,
        contextPrecision: null,
        confidence: null,
        fallbackUsed: false,
        noCitations: false,
        followUpSuspected: false,
      },
      now,
    );
    if (inserted) await recomputeRootCause(this.repo, clusterId, now);

    const cluster = await this.mustFind(clusterId);
    return {
      clusterId,
      joinedExisting: !inserted,
      representativeQuestion: cluster.representativeQuestion,
      freq: cluster.freq,
    };
  }

  /**
   * 把仓库的并发领域错误映射成 **409**（不是 400）：请求良构、刷新重试就会成功。
   * 客户端要能把它和 `assertItemsBelongTo` 的真 400 区分开，才有可能自动重试。
   */
  private async moveItems(
    itemIds: string[],
    fromClusterId: string,
    target: Parameters<GapsRepository["moveItems"]>[2],
    now: Date,
  ): ReturnType<GapsRepository["moveItems"]> {
    try {
      return await this.repo.moveItems(itemIds, fromClusterId, target, now);
    } catch (error) {
      if (error instanceof GapItemsMovedConcurrentlyError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  private async mustFind(id: string) {
    const cluster = await this.repo.findCluster(id);
    if (!cluster || cluster.deletedAt !== null) {
      throw new NotFoundException(`缺口不存在：${id}`);
    }
    return cluster;
  }

  /**
   * 读回契约形状的一行——写操作的响应要带上重算后的 freq30d/avgQuality，不能凭内存拼。
   * **按 id 单行取**，不是「列一页再 find」：后者会让一个刚被忽略的低频簇掉出首页 ⇒
   * 写成功了却回 404（peer review 抓出）。
   */
  private async mustReadBack(id: string, now: Date): Promise<GapCluster> {
    const windowStart = new Date(now.getTime() - FREQ_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const row = await this.repo.findClusterListRow(id, windowStart);
    if (!row) throw new NotFoundException(`缺口不存在：${id}`);
    return toGapCluster(row);
  }

  /**
   * 校验被搬运的 item **确实属于源簇**。
   * 少了这道，一次 split 就能把别的簇的成员搬走：两个簇的 freq 都被改写、
   * 而调用方只以为自己动了一个簇——数据错得安静且不可追溯。
   */
  private async assertItemsBelongTo(clusterId: string, itemIds: string[]): Promise<GapItemRow[]> {
    const rows = await this.repo.listItemsByIds(itemIds);
    if (rows.length !== itemIds.length) {
      throw new BadRequestException("部分 item 不存在");
    }
    const foreign = rows.filter((row) => row.clusterId !== clusterId);
    if (foreign.length > 0) {
      throw new BadRequestException(
        `以下 item 不属于本缺口，不能搬运：${foreign.map((f) => f.id).join(", ")}`,
      );
    }
    return rows;
  }
}

function toGapCluster(row: GapClusterListRow): GapCluster {
  return {
    id: row.id,
    representativeQuestion: row.representativeQuestion,
    freq: Number(row.freq),
    freq30d: Number(row.freq30d ?? 0),
    status: row.status as GapClusterStatus,
    rootCause: (row.rootCause as GapRootCause | null) ?? null,
    rootCauseIsManual: row.rootCauseIsManual,
    // 一个分数都没有的簇给 null，不是 0（Global Constraint 6）。
    avgQuality: toNumberOrNull(row.avgQuality),
    followUpRatio: toNumberOrNull(row.followUpRatio) ?? 0,
    enteredEvalSetAt: toIso(row.enteredEvalSetAt),
    // 契约只暴露布尔——时间戳会诱使前端渲染原型没定义的「N 天前复发」。
    recurred: row.recurredAt !== null,
    fillPreScore: row.fillPreScore,
    verifiedScore: row.verifiedScore,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

function toGapItem(row: GapItemRow, ttlCutoff: Date): GapItem {
  return {
    id: row.id,
    clusterId: row.clusterId,
    source: row.source as GapItem["source"],
    sourceTraceId: row.sourceTraceId,
    question: row.question,
    rewrittenQuestion: row.rewrittenQuestion,
    rewriteResolved: row.rewriteResolved,
    followUpSuspected: row.followUpSuspected,
    traceStartTime: toIso(row.traceStartTime),
    // 取不到开始时间的（手动入池）**不算过期**：无从判断，置灰会误导人以为链接已失效。
    traceExpired: row.traceStartTime !== null && row.traceStartTime < ttlCutoff,
    faithfulness: row.faithfulness,
    answerRelevancy: row.answerRelevancy,
    contextPrecision: row.contextPrecision,
    confidence: row.confidence,
  };
}
