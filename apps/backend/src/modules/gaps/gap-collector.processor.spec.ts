import type { PoolCandidate } from "./clickhouse-gaps.repository";
import {
  GAP_COLLECT_WORKER_NAME,
  RECURRENCE_MIN_ITEMS,
  RECURRENCE_WINDOW_DAYS,
  type GapClusterStatus,
  type GapRootCause,
} from "./gap.constants";
import { GapCollectorProcessor } from "./gap-collector.processor";
import type {
  AttachItemResult,
  ClusterTriageInput,
  GapClusterTarget,
  GapCollectorStore,
  GapCursorState,
  GapItemDraft,
  NearestCluster,
} from "./gaps.repository";
import { CENTROID_CAS_ATTEMPTS } from "./gap.constants";
import { GapCentroidStaleError, cosineSimilarity } from "./gap-clustering";

/**
 * 收集器 worker 的行为测试。全部断言落在**产出的簇/成员/游标**上，不断言「某方法被调用过」
 * （Global Constraint 12 明令禁止拿调用断言冒充行为验证）。
 *
 * 唯一的例外是「不碰 evaluations 域」那条：它要证明的恰恰是**没有发生的事**，
 * 只能观察依赖被怎么使用。见该用例的注释。
 */

const EMBEDDING_MODEL_ID = "22222222-2222-4222-8222-222222222222";
const JUDGE_VERSION = "online-v1";

/** 单位向量，两两余弦相似度可控：A·B = 0.99，A·C = 0.5。 */
const VEC_A = [1, 0];
const VEC_NEAR_A = [0.99, Math.sqrt(1 - 0.99 * 0.99)]; // cos(A, ·) = 0.99 ≥ 0.85
const VEC_FAR_A = [0.5, Math.sqrt(1 - 0.5 * 0.5)]; // cos(A, ·) = 0.50 < 0.85

interface FakeCluster {
  id: string;
  representativeQuestion: string;
  centroid: number[];
  freq: number;
  status: string;
  rootCauseAuto: GapRootCause | null;
  rootCauseManual: GapRootCause | null;
  deleted: boolean;
  /** 簇进入终态的时刻——复发窗口的锚点（迁移 0029）。 */
  terminalAt: Date | null;
  /** 非空即屏5 的「复发」红点。由假 `GapsService.reopenRecurred` 置。 */
  recurredAt: Date | null;
}

interface FakeItem extends GapItemDraft {
  clusterId: string;
  /** 复发判定的时间口径是**入池时间**（`gap_items.created_at`），不是 `traceStartTime`。 */
  createdAt: Date;
}

/**
 * 内存版 `GapCollectorStore`。只复刻**存储契约**（唯一索引、事务性、freq 只在真插入时涨），
 * 不复刻任何归簇/分诊判定——那些留在 processor 里，否则测的就是 fake 自己重写的一份逻辑。
 */
class FakeGapStore implements GapCollectorStore {
  clusters: FakeCluster[] = [];
  items: FakeItem[] = [];
  cursor: GapCursorState = { lastTs: "1970-01-01 00:00:00.000000000", lastTraceId: "" };
  cursorMovedAt: Date | null = null;
  leaseAvailable = true;
  /** 模拟「本轮跑超时，租约被另一个实例接管」——`finishCycle` 会影响 0 行。 */
  leaseStolen = false;
  failures: string[] = [];
  private seq = 0;

  async getOrCreateWatermark(_w: string, _now: Date, seedFrom: string): Promise<GapCursorState> {
    if (this.cursor.lastTs === "") this.cursor = { lastTs: seedFrom, lastTraceId: "" };
    return { ...this.cursor };
  }

  async tryAcquireLease(): Promise<boolean> {
    return this.leaseAvailable;
  }

  async releaseLease(): Promise<void> {}

  async recordFailure(_workerName: string, message: string): Promise<void> {
    this.failures.push(message);
  }

  async findNearestCluster(embedding: number[]): Promise<NearestCluster | null> {
    // 真实现走 pgvector `<=>` 取距离最小的一条；这里朴素扫描，取余弦最大的一条。
    // 两者都只**找**不**判**——阈值比较在 processor 里。
    const alive = this.clusters.filter((c) => !c.deleted);
    if (alive.length === 0) return null;
    const best = alive.reduce((acc, c) =>
      cosineSimilarity(c.centroid, embedding) > cosineSimilarity(acc.centroid, embedding) ? c : acc,
    );
    return { id: best.id, centroid: [...best.centroid], freq: best.freq };
  }

  /**
   * 注入并发对手：置成 N 就让接下来 N 次 `existing` 分支的写入之前，先**真的**替另一个实例
   * 并入一条样本（`freq + 1` 且质心换成 `rivalCentroid`）。
   *
   * ⚠️ 刻意**不是**「直接抛 `GapCentroidStaleError`」（初版如此，peer review P2 抓出）：
   * 那样 `freq` 不变，重试时过期的 `expectedFreq` 仍然匹配，于是「把 target 提到循环外、
   * 拿过期的 nextCentroid 重写一遍」这种**恰恰是本次要修的缺陷**的实现也能通过测试。
   * 让 fake 真的改 freq 与 centroid，重试就必须重新读、重新算才可能成功。
   */
  forceCentroidStale = 0;
  /**
   * 并发对手写入的质心。重试后的最终质心必须体现它，否则就是又被覆盖了。
   *
   * 默认值与 `VEC_A=[1,0]` 的余弦是 `1/√1.25 ≈ 0.894`，**刻意高于** `CLUSTER_SIMILARITY_MIN`
   * （0.85）：这样重试时最近邻判定仍然落回同一个簇、继续走 `existing` 分支，才测得到 CAS。
   * 若换成正交向量（如 `[0,1]`），重试会正确地判成「不相似」转而建新簇——那是另一条路径，
   * 断言 CAS 的用例就落空了。
   */
  rivalCentroid: number[] = [1, 0.5];

  async attachItem(
    target: GapClusterTarget,
    item: GapItemDraft,
    now: Date,
  ): Promise<AttachItemResult> {
    // `gap_items_source_trace_unique` 的先探分支：命中就**一行不写**地返回。
    // 真实现把它放在事务最前面，正是为了不留下「建了簇却插不进 item」的空簇。
    const seen = this.items.find((i) => i.sourceTraceId === item.sourceTraceId);
    if (seen) return { clusterId: seen.clusterId, inserted: false };

    let cluster: FakeCluster;
    if (target.kind === "existing") {
      cluster = this.clusters.find((c) => c.id === target.clusterId)!;
      // 并发对手抢先并入一条：freq 与 centroid 都真的变了（见 forceCentroidStale 的说明）。
      if (this.forceCentroidStale > 0) {
        this.forceCentroidStale -= 1;
        cluster.freq += 1;
        cluster.centroid = [...this.rivalCentroid];
      }
      /**
       * 真实现的 `WHERE freq = expectedFreq`（B2b 质心 CAS）。fake 必须一起守这条，
       * 否则「重试逻辑」在测试里根本走不到——fake 无条件放行的话，CAS 永远不失败。
       */
      if (cluster.freq !== target.expectedFreq) throw new GapCentroidStaleError(cluster.id);
    } else {
      cluster = {
        id: `cluster-${(this.seq += 1)}`,
        representativeQuestion: target.representativeQuestion,
        centroid: [...target.centroid],
        freq: 0,
        status: "pending",
        rootCauseAuto: null,
        rootCauseManual: null,
        deleted: false,
        recurredAt: null,
      };
      this.clusters.push(cluster);
    }
    // 真实现由 `RETURNING` 捎回并入**之前**的状态与终态时刻（那条 UPDATE 两列都不写）。
    const statusBeforeAttach = cluster.status as GapClusterStatus;
    const terminalAtBeforeAttach = cluster.terminalAt;
    this.items.push({ ...item, clusterId: cluster.id, createdAt: now });
    cluster.freq += 1;
    if (target.kind === "existing") cluster.centroid = [...target.nextCentroid];
    return { clusterId: cluster.id, inserted: true, statusBeforeAttach, terminalAtBeforeAttach };
  }

  /** 调用次数——「`pending` 簇不该白查一次库」那条用例要断言它没被碰过。 */
  countRecentItemsCalls = 0;

  async countRecentItems(clusterId: string, windowStart: Date): Promise<number> {
    this.countRecentItemsCalls += 1;
    return this.items.filter((i) => i.clusterId === clusterId && i.createdAt >= windowStart).length;
  }

  async listClusterTriageInputs(clusterId: string): Promise<ClusterTriageInput[]> {
    return this.items
      .filter((i) => i.clusterId === clusterId)
      .map((i) => ({
        confidence: i.confidence,
        contextPrecision: i.contextPrecision,
        faithfulness: i.faithfulness,
        followUpSuspected: i.followUpSuspected,
        source: i.source,
      }));
  }

  async setClusterRootCauseAuto(clusterId: string, cause: GapRootCause): Promise<void> {
    const cluster = this.clusters.find((c) => c.id === clusterId)!;
    cluster.rootCauseAuto = cause;
  }

  async finishCycle(
    _workerName: string,
    _owner: string,
    cursor: GapCursorState,
    now: Date,
    cursorMoved: boolean,
  ): Promise<boolean> {
    // 租约已被别人抢走时，真实现的 WHERE 带 lease_owner ⇒ 影响 0 行 ⇒ 返回 false。
    if (this.leaseStolen) return false;
    this.cursor = { ...cursor };
    if (cursorMoved) this.cursorMovedAt = now;
    return true;
  }

  seedCluster(patch: Partial<FakeCluster> & { centroid: number[] }): FakeCluster {
    const cluster: FakeCluster = {
      id: `seed-${(this.seq += 1)}`,
      representativeQuestion: "既有簇",
      freq: 1,
      status: "pending",
      rootCauseAuto: null,
      rootCauseManual: null,
      deleted: false,
      terminalAt: null,
      recurredAt: null,
      ...patch,
    };
    this.clusters.push(cluster);
    return cluster;
  }

  /** 造历史成员：`createdAt` 决定它落不落进复发窗口（`freq` 一并对齐，别造出自相矛盾的簇）。 */
  seedItems(clusterId: string, count: number, createdAt: Date): void {
    for (let i = 0; i < count; i += 1) {
      this.items.push({
        clusterId,
        createdAt,
        source: "online",
        sourceTraceId: `seeded-${clusterId}-${(this.seq += 1)}`,
        question: "历史样本",
        rewrittenQuestion: null,
        rewriteResolved: true,
        embedding: [1, 0],
        traceStartTime: createdAt,
        faithfulness: null,
        answerRelevancy: null,
        contextPrecision: null,
        confidence: 30,
        fallbackUsed: false,
        noCitations: false,
        followUpSuspected: false,
      });
    }
    const cluster = this.clusters.find((c) => c.id === clusterId);
    if (cluster) cluster.freq += count;
  }
}

function candidate(patch: Partial<PoolCandidate> & { traceId: string }): PoolCandidate {
  return {
    question: "怎么开发票",
    rewrittenQuestion: null,
    startTime: "2026-07-19T02:00:00.000Z",
    cursorTs: "2026-07-19 02:00:00.123456789",
    sessionId: "s-1",
    isFirstTurnInSession: true,
    // 百分制——`PoolCandidate.confidence` 出 repository 时已从遥测的 0–1 换算过。
    confidence: 30, // < POOL_CONFIDENCE_MAX ⇒ 入池
    fallbackUsed: false,
    noCitations: false,
    faithfulness: null,
    answerRelevancy: null,
    contextPrecision: null,
    ...patch,
  };
}

interface Harness {
  processor: GapCollectorProcessor;
  store: FakeGapStore;
  embedCalls: string[][];
  settingsReads: number;
  evaluationsTouched: string[];
}

/**
 * `embeddings` 按候选顺序一一对应（processor 批量 embed，返回顺序即入参顺序）。
 * ⚠️ 假 ClickHouse **无视游标**恒返回同一批：这正是「插入成功但游标没落库就崩了」的重投场景，
 * 幂等用例靠它才有意义（若按游标过滤，第二轮空跑，那条断言就什么都没证明）。
 */
function makeHarness(candidates: PoolCandidate[], embeddings: number[][]): Harness {
  const store = new FakeGapStore();
  const embedCalls: string[][] = [];
  const harness: Harness = {
    store,
    embedCalls,
    settingsReads: 0,
    evaluationsTouched: [],
    processor: undefined as never,
  };

  const clickhouse = { listPoolCandidates: async () => candidates.map((c) => ({ ...c })) };
  const models = {
    embedTexts: async (modelId: string, texts: string[]) => {
      expect(modelId).toBe(EMBEDDING_MODEL_ID);
      embedCalls.push(texts);
      return texts.map((_t, i) => embeddings[i]);
    },
  };
  // 「收集器绝不写 evaluations 域」（Global Constraint 9）的单测侧证据：把 evaluations 仓库
  // 包成 Proxy，记录**每一个被取用的成员名**。写入方法（finishCycle/tryAcquireLease/
  // recordFailure…）只要被碰一下就会留痕，断言「只读过 getSettings」即等价于「没写过」。
  const evaluationsTarget = {
    getSettings: async () => {
      harness.settingsReads += 1;
      return { judgeVersion: JUDGE_VERSION, embeddingModelId: EMBEDDING_MODEL_ID };
    },
  };
  const evaluations = new Proxy(evaluationsTarget, {
    get(target, prop, receiver) {
      if (typeof prop === "string") harness.evaluationsTouched.push(prop);
      return Reflect.get(target, prop, receiver);
    },
  });
  const queue = { publish: jest.fn(), subscribe: jest.fn(), schedule: jest.fn() };
  /**
   * 假 `GapsService`：只复刻 `reopenRecurred` 的**可观察效果**（状态回 `pending` + 置复发标）
   * 与它的 CAS 守卫（`from` 不合法就抛，同真实现的 400/409）。
   * 断言全部落在簇的最终状态上，不断言「这个方法被调用过」。
   */
  const gaps = {
    reopenRecurred: async (id: string, now: Date) => {
      const cluster = store.clusters.find((c) => c.id === id)!;
      if (cluster.status !== "ignored" && cluster.status !== "verified") {
        throw new Error(`illegal transition: ${cluster.status} --reopenRecurred--> pending`);
      }
      cluster.status = "pending";
      cluster.recurredAt = now;
      return undefined as never;
    },
  };

  harness.processor = new GapCollectorProcessor(
    queue as never,
    store,
    clickhouse as never,
    evaluations as never,
    models as never,
    gaps as never,
  );
  return harness;
}

const NOW = new Date("2026-07-19T04:00:00.000Z");

describe("GapCollectorProcessor（B2a 收集器：游标 + 租约 + 增量聚类 + 分诊 + 幂等）", () => {
  it("近似重复的问题归入既有簇，只涨频次不建新簇", async () => {
    const { processor, store } = makeHarness(
      [candidate({ traceId: "a".repeat(32), question: "能开专用发票吗" })],
      [VEC_NEAR_A],
    );
    store.seedCluster({ centroid: VEC_A, freq: 1, representativeQuestion: "可以开专票吗" });

    await processor.processCycle(GAP_COLLECT_WORKER_NAME, NOW);

    expect(store.clusters).toHaveLength(1);
    expect(store.clusters[0].freq).toBe(2);
    // 质心按 (c*f + v)/(f+1) 增量挪动，不是原地不动、也不是被新向量顶替。
    expect(store.clusters[0].centroid[0]).toBeCloseTo((1 * 1 + 0.99) / 2, 6);
  });

  it("相似度低于 0.85 时建新簇", async () => {
    const { processor, store } = makeHarness(
      [
        candidate({ traceId: "a".repeat(32), question: "能开专用发票吗" }),
        candidate({
          traceId: "b".repeat(32),
          question: "怎么申请退款",
          cursorTs: "2026-07-19 02:00:01.000000000",
        }),
      ],
      [VEC_A, VEC_FAR_A],
    );

    await processor.processCycle(GAP_COLLECT_WORKER_NAME, NOW);

    expect(store.clusters).toHaveLength(2);
    expect(store.clusters.map((c) => c.freq)).toEqual([1, 1]);
  });

  it("只读 evaluations 的设置，绝不写它的任何表（Global Constraint 9）", async () => {
    const harness = makeHarness([candidate({ traceId: "a".repeat(32) })], [VEC_A]);
    await harness.processor.processCycle(GAP_COLLECT_WORKER_NAME, NOW);

    expect(harness.settingsReads).toBe(1);
    expect([...new Set(harness.evaluationsTouched)]).toEqual(["getSettings"]);
    // 进度落的是自己的水位线，不是 eval_watermarks。
    expect(harness.store.cursor.lastTraceId).toBe("a".repeat(32));
  });

  it("已忽略的簇不会被复活，只涨频次", async () => {
    const { processor, store } = makeHarness(
      [candidate({ traceId: "a".repeat(32) })],
      [VEC_NEAR_A],
    );
    store.seedCluster({ centroid: VEC_A, freq: 1, status: "ignored" });

    await processor.processCycle(GAP_COLLECT_WORKER_NAME, NOW);

    expect(store.clusters[0].status).toBe("ignored");
    expect(store.clusters[0].freq).toBe(2);
  });

  it("同一批被重投两次，成员与频次都不翻倍（唯一索引兜底）", async () => {
    const { processor, store } = makeHarness([candidate({ traceId: "a".repeat(32) })], [VEC_A]);

    await processor.processCycle(GAP_COLLECT_WORKER_NAME, NOW);
    await processor.processCycle(GAP_COLLECT_WORKER_NAME, NOW);

    expect(store.items).toHaveLength(1);
    expect(store.clusters).toHaveLength(1);
    expect(store.clusters[0].freq).toBe(1);
  });

  it("游标推进到最后一条的原始纳秒时间串，不经 Date 截断", async () => {
    const lastTs = "2026-07-19 02:00:09.987654321";
    const { processor, store } = makeHarness(
      [
        candidate({ traceId: "a".repeat(32), cursorTs: "2026-07-19 02:00:00.123456789" }),
        candidate({ traceId: "b".repeat(32), cursorTs: lastTs }),
      ],
      [VEC_A, VEC_FAR_A],
    );

    await processor.processCycle(GAP_COLLECT_WORKER_NAME, NOW);

    expect(store.cursor).toEqual({ lastTs, lastTraceId: "b".repeat(32) });
    expect(store.cursorMovedAt).toEqual(NOW);
  });

  it("不满足入池判据的候选不入池，但游标照样越过它", async () => {
    // SQL 已预筛，这里是第二道：口径若两边漂移，宁可漏收也不要把正常流量灌进池子。
    const { processor, store } = makeHarness(
      [
        candidate({
          traceId: "a".repeat(32),
          confidence: 90,
          faithfulness: 90,
          answerRelevancy: 88,
          contextPrecision: 85,
          cursorTs: "2026-07-19 02:00:05.000000000",
        }),
      ],
      [VEC_A],
    );

    await processor.processCycle(GAP_COLLECT_WORKER_NAME, NOW);

    expect(store.items).toHaveLength(0);
    expect(store.clusters).toHaveLength(0);
    expect(store.cursor.lastTraceId).toBe("a".repeat(32));
  });

  it("非首轮且改写未消解 ⇒ 标记指代追问，且按原文聚类", async () => {
    const { processor, store } = makeHarness(
      [
        candidate({
          traceId: "a".repeat(32),
          question: "那个呢",
          rewrittenQuestion: "那个呢？", // 归一化后与原文一字不差 ⇒ 未消解
          isFirstTurnInSession: false,
          contextPrecision: 5, // ≤ 10 ⇒ 近乎零召回
        }),
      ],
      [VEC_A],
    );

    await processor.processCycle(GAP_COLLECT_WORKER_NAME, NOW);

    expect(store.items[0].rewriteResolved).toBe(false);
    expect(store.items[0].rewrittenQuestion).toBeNull();
    expect(store.items[0].followUpSuspected).toBe(true);
    // 簇里过半是指代追问 ⇒ 强制判 retrieval，绝不判 missing（021 §6.4 的结构性免疫）。
    expect(store.clusters[0].rootCauseAuto).toBe("retrieval");
  });

  it("改写消解成功时按改写后问题聚类，并原样落库", async () => {
    const { processor, store, embedCalls } = makeHarness(
      [
        candidate({
          traceId: "a".repeat(32),
          question: "那个能开吗",
          rewrittenQuestion: "增值税专用发票能开吗",
          isFirstTurnInSession: false,
        }),
      ],
      [VEC_A],
    );

    await processor.processCycle(GAP_COLLECT_WORKER_NAME, NOW);

    expect(embedCalls).toEqual([["增值税专用发票能开吗"]]);
    expect(store.items[0].rewriteResolved).toBe(true);
    expect(store.items[0].rewrittenQuestion).toBe("增值税专用发票能开吗");
    expect(store.clusters[0].representativeQuestion).toBe("增值税专用发票能开吗");
  });

  it("拿不到租约就整轮不动（另一个实例正在跑）", async () => {
    const { processor, store } = makeHarness([candidate({ traceId: "a".repeat(32) })], [VEC_A]);
    store.leaseAvailable = false;

    const result = await processor.processCycle(GAP_COLLECT_WORKER_NAME, NOW);

    expect(result.status).toBe("lease_busy");
    expect(store.items).toHaveLength(0);
    expect(store.cursor.lastTraceId).toBe("");
  });

  // ───────────────── 以下三条来自 peer review 抓出的缺陷（P1-3 / P2-1 / P2-2） ─────────────────

  it("重投时质心已漂移、该 trace 改判建新簇 —— 也绝不留下 freq=0 的空簇", async () => {
    // 复现路径：第一轮把 trace 收进簇 A；此后质心被挪走（这里直接改成正交向量模拟），
    // 第二轮重投同一条 ⇒ 相似度跌破阈值 ⇒ 走「建新簇」分支 ⇒ 插 item 撞唯一索引。
    // 若建簇发生在探测之前，这里就会多出一个零成员的簇，且无自愈路径。
    const { processor, store } = makeHarness([candidate({ traceId: "a".repeat(32) })], [VEC_A]);

    await processor.processCycle(GAP_COLLECT_WORKER_NAME, NOW);
    expect(store.clusters).toHaveLength(1);
    store.clusters[0].centroid = [0, 1]; // 与 VEC_A 正交 ⇒ 相似度 0

    await processor.processCycle(GAP_COLLECT_WORKER_NAME, NOW);

    expect(store.clusters).toHaveLength(1); // 没有多出空簇
    expect(store.clusters[0].freq).toBe(1);
    expect(store.items).toHaveLength(1);
  });

  // ───────────────── B2b：质心 CAS（021 §12② 的收口） ─────────────────

  it("质心 CAS 冲突后重算重试：最终质心体现**双方**的贡献，而不是覆盖掉对手", async () => {
    // 一轮内两条同向量候选：第一条建簇（centroid = VEC_A，freq 1），第二条归入它。
    // 给第二条注入一个**真的写了库**的并发对手：freq → 2、centroid → rivalCentroid。
    // 正确实现必须重新读到 (rival, 2) 再算增量平均；若拿旧的 nextCentroid 重写，
    // 对手那次贡献就被抹掉——下面对质心数值的断言正是用来抓这件事的。
    const { processor, store } = makeHarness(
      [candidate({ traceId: "a".repeat(32) }), candidate({ traceId: "b".repeat(32) })],
      [VEC_A, VEC_A],
    );
    store.forceCentroidStale = 1;

    const result = await processor.processCycle(GAP_COLLECT_WORKER_NAME, NOW);

    expect(result.status).toBe("healthy");
    expect(store.clusters).toHaveLength(1);
    expect(store.clusters[0].freq).toBe(3); // 建簇 1 + 对手 1 + 重试成功 1
    expect(store.items).toHaveLength(2);

    // 重试时观察到的是 (centroid=[1,0.5], freq=2)，并入 VEC_A=[1,0] 后应为
    // ([1,0.5]*2 + [1,0]) / 3 = [1, 1/3]。若实现把 target 提到循环外、拿过期的
    // nextCentroid 重写一遍（正是本次要修的缺陷），第二维会是 0 而不是 1/3。
    expect(store.clusters[0].centroid[0]).toBeCloseTo(1, 10);
    expect(store.clusters[0].centroid[1]).toBeCloseTo(1 / 3, 10);
  });

  it("CAS 一直冲突时**只放弃那一条**，整轮照常收尾（不掀翻 finishCycle）", async () => {
    // 让它冒泡出整轮的话，游标一步不动、本轮已入池的条目下轮全部白跑，
    // 而只要那个簇持续被别的实例写，每轮都以同样方式崩——就是「永久崩溃循环」。
    const { processor, store } = makeHarness(
      [
        candidate({ traceId: "a".repeat(32), cursorTs: "2026-07-19 02:00:01.000000000" }),
        candidate({ traceId: "b".repeat(32), cursorTs: "2026-07-19 02:00:02.000000000" }),
      ],
      [VEC_A, VEC_A],
    );
    store.forceCentroidStale = 99; // 每次都冲突

    const result = await processor.processCycle(GAP_COLLECT_WORKER_NAME, NOW);

    expect(result.status).toBe("healthy"); // 整轮走完，不是抛出
    expect(result.collected).toBe(1); // 只有第一条入池
    // 游标停在冲突那条**之前**：下一轮它还会被重新扫到。
    expect(store.cursor).toEqual({
      lastTs: "2026-07-19 02:00:01.000000000",
      lastTraceId: "a".repeat(32),
    });
  });

  it("CAS 失败不会留下半条数据：那条 item 没插进去", async () => {
    const { processor, store } = makeHarness(
      [candidate({ traceId: "a".repeat(32) }), candidate({ traceId: "b".repeat(32) })],
      [VEC_A, VEC_A],
    );
    store.forceCentroidStale = 99;

    await processor.processCycle(GAP_COLLECT_WORKER_NAME, NOW);

    // 第一条正常入池；第二条一路撞 CAS ⇒ **它自己一行都没写进去**。
    // 真实现靠事务回滚保证这点；fake 的 CAS 检查发生在插 item 之前，等价。
    expect(store.items).toHaveLength(1);
    expect(store.items[0].sourceTraceId).toBe("a".repeat(32));

    // freq 只反映「建簇 1 + 并发对手每次尝试各并入 1」；**没有**我方的贡献。
    // 断言具体数值而不是「没涨」：对手是真的在写库（这正是 fake 要模拟的并发），
    // 写成「不涨」反而会把一个忠实的 fake 判成错的。
    expect(store.clusters[0].freq).toBe(1 + CENTROID_CAS_ATTEMPTS);
  });

  it("租约被接管时如实报 lease_lost，不假装 healthy", async () => {
    const { processor, store } = makeHarness([candidate({ traceId: "a".repeat(32) })], [VEC_A]);
    store.leaseStolen = true; // 本轮跑超时，游标 UPDATE 影响 0 行

    const result = await processor.processCycle(GAP_COLLECT_WORKER_NAME, NOW);

    expect(result.status).toBe("lease_lost");
    expect(store.cursor.lastTraceId).toBe(""); // 游标确实没动
  });

  it("embedding 少返时游标停在缺失那条之前，不把它甩掉", async () => {
    // provider 截断/短返：三条候选只回来两个向量。第三条既没入池，游标也不该越过它——
    // `listPoolCandidates` 只往前看，越过即永久丢失，且所有指标看上去都正常。
    const { processor, store } = makeHarness(
      [
        candidate({ traceId: "a".repeat(32), cursorTs: "2026-07-19 02:00:01.000000000" }),
        candidate({ traceId: "b".repeat(32), cursorTs: "2026-07-19 02:00:02.000000000" }),
        candidate({ traceId: "c".repeat(32), cursorTs: "2026-07-19 02:00:03.000000000" }),
      ],
      [VEC_A, VEC_FAR_A], // 第三条没有向量
    );

    const result = await processor.processCycle(GAP_COLLECT_WORKER_NAME, NOW);

    expect(result.status).toBe("healthy");
    expect(store.items).toHaveLength(2);
    // 停在 b：c 下一轮还会被重新扫到。
    expect(store.cursor).toEqual({
      lastTs: "2026-07-19 02:00:02.000000000",
      lastTraceId: "b".repeat(32),
    });
  });

  it("没配 embedding 模型时不推进游标——否则这段流量永远补不回来", async () => {
    const { processor, store } = makeHarness([candidate({ traceId: "a".repeat(32) })], [VEC_A]);
    (processor as unknown as { evaluations: { getSettings: () => Promise<unknown> } }).evaluations =
      { getSettings: async () => ({ judgeVersion: JUDGE_VERSION, embeddingModelId: null }) };

    const result = await processor.processCycle(GAP_COLLECT_WORKER_NAME, NOW);

    expect(result.status).toBe("model_unavailable");
    expect(store.cursor.lastTraceId).toBe("");
    expect(store.failures).toHaveLength(1);
  });

  // ───────────────── B2b：「复发」重开（原型 `:376` / `:708`） ─────────────────
  //
  // 规则：已「已入库/已忽略」的簇再收到相似新问题只涨频次、不重开；但若在
  // `RECURRENCE_WINDOW_DAYS` 天内新增达到 `RECURRENCE_MIN_ITEMS` 条，自动重开为
  // `pending` 并标「复发」。本轮新入池的这一条**计入**分子（它正是压垮阈值的那根稻草）。

  /** 窗口内的时间点：足够旧到能和「本轮新增」区分开，又没出窗口。 */
  const IN_WINDOW = new Date(NOW.getTime() - (RECURRENCE_WINDOW_DAYS - 1) * 24 * 60 * 60 * 1000);
  /** 窗口外：比窗口起点还早一天。 */
  const OUT_OF_WINDOW = new Date(
    NOW.getTime() - (RECURRENCE_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000,
  );

  it(`已忽略的簇窗口内新增第 ${RECURRENCE_MIN_ITEMS} 条 ⇒ 重开为 pending 并标复发`, async () => {
    const { processor, store } = makeHarness(
      [candidate({ traceId: "a".repeat(32) })],
      [VEC_NEAR_A],
    );
    const cluster = store.seedCluster({ centroid: VEC_A, freq: 0, status: "ignored" });
    // 本轮这条落地后正好凑满阈值。
    store.seedItems(cluster.id, RECURRENCE_MIN_ITEMS - 1, IN_WINDOW);

    await processor.processCycle(GAP_COLLECT_WORKER_NAME, NOW);

    expect(store.clusters[0].status).toBe("pending");
    expect(store.clusters[0].recurredAt).toEqual(NOW);
  });

  it(`窗口内只有 ${RECURRENCE_MIN_ITEMS - 1} 条时不重开（阈值是「达到」不是「接近」）`, async () => {
    const { processor, store } = makeHarness(
      [candidate({ traceId: "a".repeat(32) })],
      [VEC_NEAR_A],
    );
    const cluster = store.seedCluster({ centroid: VEC_A, freq: 0, status: "ignored" });
    store.seedItems(cluster.id, RECURRENCE_MIN_ITEMS - 2, IN_WINDOW);

    await processor.processCycle(GAP_COLLECT_WORKER_NAME, NOW);

    expect(store.clusters[0].status).toBe("ignored");
    expect(store.clusters[0].recurredAt).toBeNull();
  });

  it("**刚被忽略的热簇不会被它忽略之前的历史立刻顶回来**（窗口从终态时刻起算）", async () => {
    // peer review P2：原型说的是「已回验**后** 7 天内新增 ≥5 条」——锚点是终态时刻。
    // 只按滚动 7 天数的话，一个本周命中过 N 次的热簇，运营刚点「忽略」，
    // 下一条相似样本进来计数就已过阈值、立刻重开——「频次+1 但不重开」对**真正会被忽略的簇**
    // 永远不成立，[忽略] 按钮等于没有。
    const { processor, store } = makeHarness(
      [candidate({ traceId: "a".repeat(32) })],
      [VEC_NEAR_A],
    );
    const justIgnored = new Date(NOW.getTime() - 60 * 1000); // 一分钟前刚被忽略
    const cluster = store.seedCluster({
      centroid: VEC_A,
      freq: 0,
      status: "ignored",
      terminalAt: justIgnored,
    });
    // 忽略**之前**就攒够了阈值的历史样本，且全都落在滚动 7 天窗口内。
    store.seedItems(cluster.id, RECURRENCE_MIN_ITEMS + 2, IN_WINDOW);

    await processor.processCycle(GAP_COLLECT_WORKER_NAME, NOW);

    // 忽略之后只新增了本轮这 1 条，远不到阈值 ⇒ 只涨频次，不重开。
    expect(store.clusters[0].status).toBe("ignored");
    expect(store.clusters[0].recurredAt).toBeNull();
  });

  it("终态之后才攒够阈值 ⇒ 照常重开（锚点不是「永不重开」的挡箭牌）", async () => {
    const { processor, store } = makeHarness(
      [candidate({ traceId: "a".repeat(32) })],
      [VEC_NEAR_A],
    );
    // 很久以前就被忽略了，此后窗口内又攒了 N-1 条，本轮这条压垮阈值。
    const longAgo = new Date(NOW.getTime() - RECURRENCE_WINDOW_DAYS * 10 * 24 * 60 * 60 * 1000);
    const cluster = store.seedCluster({
      centroid: VEC_A,
      freq: 0,
      status: "ignored",
      terminalAt: longAgo,
    });
    store.seedItems(cluster.id, RECURRENCE_MIN_ITEMS - 1, IN_WINDOW);

    await processor.processCycle(GAP_COLLECT_WORKER_NAME, NOW);

    expect(store.clusters[0].status).toBe("pending");
    expect(store.clusters[0].recurredAt).toEqual(NOW);
  });

  it("窗口外的老样本不进分子——否则一个陈年老簇随便来一条就会被顶回待处理", async () => {
    const { processor, store } = makeHarness(
      [candidate({ traceId: "a".repeat(32) })],
      [VEC_NEAR_A],
    );
    const cluster = store.seedCluster({ centroid: VEC_A, freq: 0, status: "ignored" });
    // 总数够阈值，但全部落在窗口之外 ⇒ 分子只有本轮这一条。
    store.seedItems(cluster.id, RECURRENCE_MIN_ITEMS - 1, OUT_OF_WINDOW);

    await processor.processCycle(GAP_COLLECT_WORKER_NAME, NOW);

    expect(store.clusters[0].status).toBe("ignored");
    expect(store.clusters[0].recurredAt).toBeNull();
  });

  it("已回验的簇同样会被复发重开（补过库、验过了，结果又坏了）", async () => {
    const { processor, store } = makeHarness(
      [candidate({ traceId: "a".repeat(32) })],
      [VEC_NEAR_A],
    );
    const cluster = store.seedCluster({ centroid: VEC_A, freq: 0, status: "verified" });
    store.seedItems(cluster.id, RECURRENCE_MIN_ITEMS - 1, IN_WINDOW);

    await processor.processCycle(GAP_COLLECT_WORKER_NAME, NOW);

    expect(store.clusters[0].status).toBe("pending");
    expect(store.clusters[0].recurredAt).toEqual(NOW);
  });

  it("并入 pending 簇时连查都不查——绝大多数样本走这条路，白查一次库就是翻倍开销", async () => {
    // 这条例外地断言「某方法没被调用」：要证明的恰恰是**没有发生的 IO**，
    // 从最终状态上观察不到（pending 簇本来就不会被重开，状态断言恒真）。
    const { processor, store } = makeHarness(
      [candidate({ traceId: "a".repeat(32) })],
      [VEC_NEAR_A],
    );
    const cluster = store.seedCluster({ centroid: VEC_A, freq: 0, status: "pending" });
    store.seedItems(cluster.id, RECURRENCE_MIN_ITEMS + 5, IN_WINDOW);

    await processor.processCycle(GAP_COLLECT_WORKER_NAME, NOW);

    expect(store.countRecentItemsCalls).toBe(0);
    expect(store.clusters[0].status).toBe("pending");
  });

  it("新建的簇永不触发复发——它此刻就是 pending", async () => {
    const { processor, store } = makeHarness([candidate({ traceId: "a".repeat(32) })], [VEC_A]);

    await processor.processCycle(GAP_COLLECT_WORKER_NAME, NOW);

    expect(store.clusters).toHaveLength(1);
    expect(store.clusters[0].status).toBe("pending");
    expect(store.countRecentItemsCalls).toBe(0);
  });
});
