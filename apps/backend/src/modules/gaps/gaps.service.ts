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
import { GapCentroidStaleError } from "./gap-clustering";
import { assignToCluster, recomputeRootCause } from "./gap-ingest";
import {
  GapItemsMovedConcurrentlyError,
  GapsRepository,
  type GapClusterListRow,
} from "./gaps.repository";
import type { GapItemRow } from "./schema";

/**
 * 缺口簇的状态机与簇操作（021 决策 A / 决策 J）。
 *
 * 合法迁移**穷举成常量表**，非法迁移一律 400。写成表而不是散在各方法里的 if：
 * B2b 加四个态时只改这一张表 + DB 的 CHECK（迁移 0028），不必翻遍所有分支找漏网的迁移。
 *
 * ⚠️ `ignore` 的 `from` 覆盖**全部六个非 `ignored` 态**——原型 §18.C 那一行写的是
 * 「任意非终 --忽略(用户)--> ignored」。一度只放行 `pending`/`routed_retrieval`，
 * 那会让「草拟到一半发现这个缺口根本不值得补」的人无路可走：他得先取消草拟回到 pending
 * 才能忽略，多一步且没有任何道理。同理「已入库但回验前就发现补错了」也要能直接忽略。
 * 从 `ignored` 再 `ignore` 仍是非法（幂等重复点击应当被明确拒绝，而不是静默 no-op）。
 *
 * 事件分两类：
 *  · **用户可达**（经 HTTP 端点，可能隔着一层分派）：
 *    `ignore` / `reopen` / `routeRetrieval`（`GapsController`，走公开的 `transition()`）；
 *    `startDraft`（`POST :id/draft-fill`）；
 *    `cancelDraft` 与 `cancelReview`（**共用** `POST :id/cancel-fill`，由 `GapFillService`
 *    按当前状态分派——`drafting` 走前者、`reviewing` 走后者）。
 *  · **纯系统触发**（编排内部调用，没有任何端点能直接触发）：
 *    `draftReady` / `submitFill` / `verifyPass` / `verifyFail` / `verifyIngestFailed` / `reopenRecurred`。
 * 后者同样走这张表——「回验完成」也是一次要被校验的迁移，不该因为调用方是自己人就跳过守卫。
 */
const TRANSITIONS = {
  ignore: {
    from: ["pending", "routed_retrieval", "drafting", "reviewing", "filled", "verified"],
    to: "ignored",
  },
  reopen: { from: ["ignored"], to: "pending" },
  routeRetrieval: { from: ["pending"], to: "routed_retrieval" },
  startDraft: { from: ["pending"], to: "drafting" },
  /** 草拟失败 / 用户取消。草稿字段**保留**——原型 `:704`「草稿保留可再编辑」。 */
  cancelDraft: { from: ["drafting"], to: "pending" },
  draftReady: { from: ["drafting"], to: "reviewing" },
  /** 人审驳回。同样保留草稿，下次进向导可直接从第②步继续。 */
  cancelReview: { from: ["reviewing"], to: "pending" },
  submitFill: { from: ["reviewing"], to: "filled" },
  verifyPass: { from: ["filled"], to: "verified" },
  /** 回验分数 <80（或判分失败）。副作用置 `recurred_at`——原型 `:706`「open + 复发标」。 */
  verifyFail: { from: ["filled"], to: "pending" },
  /**
   * 提交入库的文档自身处理失败（解析/切片/embedding 炸了），**不是**分数不达标。
   * 与 `verifyFail` 同样回到 `pending`，但**不置复发标**：那是本次补库操作的工程故障，
   * 不是「这个知识缺口又出现新证据了」。混进同一个红点，运营就分不清该重投文档还是该重查缺口。
   */
  verifyIngestFailed: { from: ["filled"], to: "pending" },
  /**
   * worker 发现已终结的簇 7 天内又新增 ≥5 条相似样本（原型 `:376`/`:708`）。
   * 与用户手动 `reopen` 分开：那条只从 `ignored` 起、且不打复发标；这条还覆盖 `verified`
   * （「补过库、验过了，结果又坏了」正是最该重开的情形）。
   */
  reopenRecurred: { from: ["ignored", "verified"], to: "pending" },
} as const satisfies Record<string, { from: readonly GapClusterStatus[]; to: GapClusterStatus }>;

export type GapTransition = keyof typeof TRANSITIONS;

/**
 * **用户**可以直接触发的迁移——公开 `transition()` 只收这三个。
 *
 * 其余 8 个是系统事件，必须走各自的具名方法（`recordDraftReady`/`submitFill`/`recordVerify*`…），
 * 因为它们都带**必须同时落库的载荷**。若公开方法收全量 `GapTransition`，controller 里一行
 * `transition(id, "submitFill")` 就能把簇推进 `filled` 却不带 `fill_target_document_id`——
 * 而回验监听器正是按那个 id 反查簇的，这行从此对它永久不可见（peer review P2 抓出）。
 */
export type GapUserTransition = Extract<
  GapTransition,
  "ignore" | "reopen" | "routeRetrieval"
>;

/** 迁移可以顺带写的载荷列。与状态一起进**同一条 UPDATE**（见 `applyTransition`）。 */
export interface GapTransitionPatch {
  fillDraftQuestion?: string;
  fillDraftAnswer?: string;
  fillTargetKbId?: string;
  fillTargetDocumentId?: string | null;
  fillVerifyApplicationId?: string;
  fillVerifyConfigVersionId?: string;
  fillPreScore?: number | null;
  verifiedScore?: number | null;
  recurredAt?: Date | null;
}

/** 向导/回验编排要读的窄投影（不含 centroid 等与它们无关的列）。 */
export interface GapFillState {
  id: string;
  status: GapClusterStatus;
  representativeQuestion: string;
  fillDraftQuestion: string | null;
  fillDraftAnswer: string | null;
  fillTargetKbId: string | null;
  fillTargetDocumentId: string | null;
  fillVerifyApplicationId: string | null;
  fillVerifyConfigVersionId: string | null;
  fillPreScore: number | null;
}

/**
 * 按**码点**截断到 `max` 个字符。
 *
 * 不用 `String.prototype.slice`：它按 UTF-16 码元切，正好切在代理对中间就留下一个孤立代理，
 * PG 以非法 UTF-8 拒收——一个本来只为兜底列宽的动作反而制造 500（peer review P3）。
 */
function truncateByCodePoint(value: string, max: number): string {
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, max).join("");
}

/**
 * 用户**主动推进**该簇时清除「复发」提醒——语义是「人已经看到这次复发并采取了行动」。
 *
 * `reopen`（ignored → pending）**刻意不在其中**：那是一条独立的手动迁移，与复发判定无关；
 * 若 `recurred_at` 当时因为别的原因非空，手动重开不该顺手抹掉这个信号。
 */
const CLEARS_RECURRED = new Set<GapTransition>(["ignore", "routeRetrieval", "startDraft"]);

/**
 * 「已终结」的两个状态——复发判定只对它们生效（原型 `:376`/`:708`：
 * 「已入库/已忽略的簇再收到相似问题只涨频次不重开；已回验后 7 天内 ≥5 条才重开」）。
 * 进入其一时记 `terminal_at` 作为那个 7 天窗口的起点。
 */
const TERMINAL_STATUSES = new Set<GapClusterStatus>(["ignored", "verified"]);

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

  /**
   * **用户**触发的状态迁移（controller 的入口）。非法迁移抛 400 并说清「从哪到哪不允许」，
   * 不静默 no-op。
   *
   * 参数类型刻意是 `GapUserTransition` 而非全量 `GapTransition`：系统事件都带必须同时落库的
   * 载荷，只能走各自的具名方法。见 `GapUserTransition` 的说明。
   */
  async transition(id: string, event: GapUserTransition, now = new Date()): Promise<GapCluster> {
    return this.applyTransition(id, event, now);
  }

  /**
   * 迁移执行的**唯一**实现：校验 → **一条 UPDATE 同时写状态、载荷列与复发标** → 读回。
   *
   * 所有迁移都经由它，「非法迁移一律 400」这条不变量因此只有一处实现——B2b 加了 8 个事件，
   * 若每个方法各写一遍守卫，漏掉任何一个都是静默放行。
   *
   * ⚠️ **载荷与状态必须落在同一条 UPDATE 里，不能拆成两次写**（peer review P1 抓出）。
   * 初版写成「先跑副作用、再写状态」，`verifyIngestFailed` 恰好是反例：它的副作用是
   * **清空** `fill_target_document_id`，两次写之间崩溃就留下 `status='filled'` 且
   * documentId 为 NULL 的行——而回验监听器正是按 documentId 反查簇的，此后无论文档事件
   * 重投多少次都再也找不到它；`filled` 态又只剩系统事件（不可达）与 `ignore` 可走，
   * 用户连重试补库都做不到，只能弃掉整个簇。合成一条 UPDATE 后这个中间态在物理上不存在。
   *
   * ⚠️ **WHERE 带 `status = 期望值` 的 CAS**（peer review P2 抓出）。`mustFind` 读状态与
   * UPDATE 写状态之间有窗口：并发的 `verifyPass` + `verifyFail` 会双双通过守卫，
   * 结果是 `verified_score` 被写两次、且 `recurred_at` 落在一个最终 `verified` 的行上——
   * 原型 §18.C 里没有「已回验 + 复发」这种组合。影响 0 行即抛 409（请求良构、刷新重试即可），
   * 与 `moveItems` 的 `GapItemsMovedConcurrentlyError` 同款处置。
   */
  private async applyTransition(
    id: string,
    event: GapTransition,
    now: Date,
    /**
     * **惰性**（函数而非现成对象）：载荷的构造可能自己就会抛（截断、格式化…），
     * 提前求值会让一次**非法迁移**先炸在载荷构造上——本该是 400「不允许从 X 到 Y」，
     * 结果给了个 500 TypeError（peer review P2 实测到：`pending --submitFill-->` 正是如此）。
     * 守卫先跑、载荷后算，错误类型才与原因对得上。
     */
    buildPatch: () => GapTransitionPatch = () => ({}),
  ): Promise<GapCluster> {
    const cluster = await this.mustFind(id);
    const rule = TRANSITIONS[event];
    if (!(rule.from as readonly string[]).includes(cluster.status)) {
      throw new BadRequestException(
        `illegal transition: ${cluster.status} --${event}--> ${rule.to}（允许的来源：${rule.from.join(" / ")}）`,
      );
    }
    const patch = buildPatch();
    const applied = await this.repo.applyTransition(
      id,
      cluster.status,
      {
        status: rule.to,
        /**
         * 进入终态时打上「复发窗口的锚点」（迁移 0029）。离开终态时清掉，
         * 免得下一轮终态沿用上一轮的旧锚点，把窗口错误地往前拉长。
         */
        terminalAt: TERMINAL_STATUSES.has(rule.to) ? now : null,
        ...patch,
        // 复发标的清除也在这条 UPDATE 里——否则崩在中间会留下一个已被处置却仍标红的簇。
        ...(CLEARS_RECURRED.has(event) ? { recurredAt: null } : {}),
      },
      now,
    );
    if (!applied) {
      throw new ConflictException(
        `缺口状态在本次操作期间被改动过（并发的 ${event}？），请刷新后重试`,
      );
    }
    return this.mustReadBack(id, now);
  }

  // ───────────────── B2b [补知识库] 向导与回验的状态迁移（021 决策 J） ─────────────────
  //
  // 这几个方法是系统事件（draftReady/submitFill/verify*）的**唯一**入口——公开的
  // `transition()` 只收用户事件（见其签名 `GapUserTransition`）。否则 controller 里一行
  // `transition(id, "submitFill")` 就能落进 `filled` 却没有 documentId，
  // 对回验监听器永久不可见（peer review P2）。

  /**
   * 点 [补知识库]：`pending → drafting`，并**快照当下的 avgQuality** 作为「41→89」的左端。
   *
   * 为什么必须此刻快照而不是展示时现读：`avgQuality` 是对 `gap_items` 的查询期聚合
   * （`selectClusterRows`），而向导从点击到入库完成回验可能跨越数分钟到下一个收集器周期。
   * 现读会让「之前」这个数随新坏样本涌入而静默漂移，展示出来的就不再是用户当时看到的那个分。
   */
  async startDraft(id: string, now = new Date()): Promise<GapCluster> {
    const windowStart = new Date(now.getTime() - FREQ_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const row = await this.repo.findClusterListRow(id, windowStart);
    // 读不到行 = 簇在 mustFind 与此之间被软删了。记 NULL 会把它与「这个簇一个分都没有」
    // 混为一谈（两者都显示为「未评」），而前者其实是不该继续的 404。
    if (!row) throw new NotFoundException(`缺口不存在：${id}`);
    const preScore = toNumberOrNull(row.avgQuality);
    return this.applyTransition(id, "startDraft", now, () => ({
      fillPreScore: preScore === null ? null : Math.round(preScore),
    }));
  }

  /** 草拟失败 / 用户取消：回 `pending`，草稿字段保留（原型 `:704`）。 */
  async cancelDraft(id: string, now = new Date()): Promise<GapCluster> {
    return this.applyTransition(id, "cancelDraft", now);
  }

  /** LLM 草拟成功：写草稿 Q/A 并进入待人审。 */
  async recordDraftReady(
    id: string,
    question: string,
    answer: string,
    now = new Date(),
  ): Promise<GapCluster> {
    return this.applyTransition(id, "draftReady", now, () => ({
      // 按**码点**截断，不是 `slice`：UTF-16 码元切法会把一个代理对劈成孤立代理，
      // PG 拒收非法 UTF-8，于是「兜底」反而制造 500（peer review P3）。
      fillDraftQuestion: truncateByCodePoint(question, 200),
      fillDraftAnswer: answer,
    }));
  }

  /** 人审驳回：回 `pending`，草稿保留供再次编辑。 */
  async cancelReview(id: string, now = new Date()): Promise<GapCluster> {
    return this.applyTransition(id, "cancelReview", now);
  }

  /**
   * 人审通过并已真的调用过入库管线：记下目标 KB / 文档 / 回验用的应用与版本，
   * 并把**人审后的最终 Q/A** 覆盖回草稿列——留档的要是真正入库的那份内容，
   * 而不是 LLM 的原稿（否则事后追「这份文档怎么来的」会翻出一份对不上的东西）。
   */
  async submitFill(
    id: string,
    target: {
      question: string;
      answer: string;
      targetKbId: string;
      applicationId: string;
      configVersionId: string;
      documentId: string;
    },
    now = new Date(),
  ): Promise<GapCluster> {
    return this.applyTransition(id, "submitFill", now, () => ({
      fillDraftQuestion: truncateByCodePoint(target.question, 200),
      fillDraftAnswer: target.answer,
      fillTargetKbId: target.targetKbId,
      fillVerifyApplicationId: target.applicationId,
      fillVerifyConfigVersionId: target.configVersionId,
      fillTargetDocumentId: target.documentId,
    }));
  }

  /** 回验通过（≥ `VERIFY_PASS_THRESHOLD`）：记新分数，屏5 显示「✓ 41→89」。 */
  async recordVerifyPass(id: string, score: number, now = new Date()): Promise<GapCluster> {
    return this.applyTransition(id, "verifyPass", now, () => ({ verifiedScore: score }));
  }

  /** 回验未通过（分数 <80，或判分整体失败）：回 `pending` + 复发标（原型 `:706`）。 */
  async recordVerifyFail(id: string, score: number | null, now = new Date()): Promise<GapCluster> {
    return this.applyTransition(id, "verifyFail", now, () => ({
      verifiedScore: score,
      recurredAt: now,
    }));
  }

  /**
   * 提交入库的文档处理失败：回 `pending`，清掉指向那份废文档的引用，**不置复发标**。
   * 复发是业务信号（缺口又出现了），入库失败是工程故障（文档没解析成），UI 文案也不同。
   */
  async recordVerifyIngestFailed(id: string, now = new Date()): Promise<GapCluster> {
    return this.applyTransition(id, "verifyIngestFailed", now, () => ({
      fillTargetDocumentId: null,
    }));
  }

  /**
   * worker 发现已终结的簇又冒出新样本（7 天内 ≥5 条）：重开并标复发（原型 `:708`）。
   * 走状态机而不是让收集器直接 UPDATE status——「一切迁移都过 TRANSITIONS」这条不变量
   * 若在第一个消费者身上就破例，它就不再是不变量了。
   */
  async reopenRecurred(id: string, now = new Date()): Promise<GapCluster> {
    return this.applyTransition(id, "reopenRecurred", now, () => ({ recurredAt: now }));
  }

  /**
   * 向导/回验编排要读的载荷列（不在契约 `GapCluster` 上）。
   *
   * **窄投影**而不是把整行交出去：原始行带着 1024 维 `centroid` 与 `deletedAt`，
   * 让编排层拿到它们没有意义，还会让「谁读了什么」变得不可追（peer review P3）。
   */
  async mustFindForFill(id: string): Promise<GapFillState> {
    const row = await this.mustFind(id);
    return {
      id: row.id,
      status: row.status as GapClusterStatus,
      representativeQuestion: row.representativeQuestion,
      fillDraftQuestion: row.fillDraftQuestion,
      fillDraftAnswer: row.fillDraftAnswer,
      fillTargetKbId: row.fillTargetKbId,
      fillTargetDocumentId: row.fillTargetDocumentId,
      fillVerifyApplicationId: row.fillVerifyApplicationId,
      fillVerifyConfigVersionId: row.fillVerifyConfigVersionId,
      fillPreScore: row.fillPreScore,
    };
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

    const { clusterId, inserted } = await this.assignToClusterOr409(body.question, {
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
    }, now);
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
   * 手动入池的归簇。`assignToCluster` 内部已经重算重试过 `CENTROID_CAS_ATTEMPTS` 次，
   * 仍冲突才会抛到这里——说明有别的实例在持续写同一个簇。
   *
   * 映射成 **409 + 中文文案**，不让哨兵裸奔成 500：请求本身完全良构、刷新重试就会成功，
   * 而 500 会把「稍等再试」误导成「系统坏了」。收集器那条路径不走这里——它按
   * 「本轮不处理这条、游标不越过」处置（见 `gap-collector.processor.ts`）。
   */
  private async assignToClusterOr409(
    clusterKey: string,
    draft: Parameters<typeof assignToCluster>[2],
    now: Date,
  ): ReturnType<typeof assignToCluster> {
    try {
      return await assignToCluster(this.repo, clusterKey, draft, now);
    } catch (error) {
      if (error instanceof GapCentroidStaleError) {
        throw new ConflictException("该缺口正在被并发更新，请稍后重试");
      }
      throw error;
    }
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
