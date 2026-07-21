import {
  CENTROID_CAS_ATTEMPTS,
  CLUSTER_SIMILARITY_MIN,
  GAP_TERMINAL_STATUSES,
  type GapClusterStatus,
  RECURRENCE_MIN_ITEMS,
  RECURRENCE_WINDOW_DAYS,
} from "./gap.constants";
import { GapCentroidStaleError, cosineSimilarity, updateCentroid } from "./gap-clustering";
import { triageCluster, triageItem } from "./gap-triage";
import type {
  AttachItemResult,
  GapClusterTarget,
  GapCollectorStore,
  GapItemDraft,
} from "./gaps.repository";

/**
 * 入池的两个共享动作：**归簇** 与 **重算簇根因**。
 *
 * 两个调用方——收集器 worker（自动，批量）与 `GapsService.addItem`（人从 Trace 详情手动挑一条）
 * ——必须用**同一套**判定：若各写一份，「手动加的样本会不会和自动收的归到同一个簇」就变成
 * 两份实现的巧合，而原型 `:648`「已在缺口『…』(×N) 中」正依赖它们口径一致。
 *
 * 抽成纯函数而不是 Nest service：它没有自己的状态，只是把 store 与三个纯函数编排起来。
 */

/**
 * 最近邻归簇：相似度 ≥ 阈值并入既有簇（质心增量平均），否则建新簇。
 *
 * pgvector 只用来**找**候选，相似度由 `cosineSimilarity` 重算 —— 判定只有一处实现，
 * 且是被表驱动单测覆盖的那处（详见 `gaps.repository.ts:findNearestCluster` 的注释）。
 *
 * **质心 CAS 的重试放在这里**（B2b：021 §12② 的收口），不放在两个调用方各自那边：
 * 冲突后必须重新 `findNearestCluster` + 重算 `updateCentroid`（旧的 nextCentroid 已过期，
 * 最近簇甚至可能换了一个），而这两步正是本函数的全部内容。放这儿对
 * 收集器 worker 与 `GapsService.addItem` 两个调用方都**透明**，也不会出现
 * 「两个调用方各写一份重试、口径悄悄漂移」——这正是本文件头注释在讲的那件事。
 *
 * 试满 `CENTROID_CAS_ATTEMPTS` 仍冲突就把哨兵抛给调用方。**调用方必须逐条接住它**
 * （收集器在 `ingest` 处按「本轮不处理这条、游标不越过它」处理，同 embedding 缺失的既定做法），
 * 而不是让它冒泡出整轮——后者会让 `finishCycle` 根本不执行，一个持续热的簇就能把每一轮都拖崩，
 * 正是 `gap-collector.processor.ts` 对 embedding 缺失那段注释所说的「永久崩溃循环」。
 */
export async function assignToCluster(
  store: GapCollectorStore,
  clusterKey: string,
  draft: GapItemDraft,
  now: Date,
): Promise<AttachItemResult> {
  for (let attempt = 1; ; attempt += 1) {
    const nearest = await store.findNearestCluster(draft.embedding);
    const similarity = nearest ? cosineSimilarity(nearest.centroid, draft.embedding) : 0;
    const target: GapClusterTarget =
      nearest && similarity >= CLUSTER_SIMILARITY_MIN
        ? {
            kind: "existing",
            clusterId: nearest.id,
            nextCentroid: updateCentroid(nearest.centroid, nearest.freq, draft.embedding),
            expectedFreq: nearest.freq,
          }
        : { kind: "new", representativeQuestion: clusterKey, centroid: draft.embedding };
    try {
      return await store.attachItem(target, draft, now);
    } catch (error) {
      if (!(error instanceof GapCentroidStaleError) || attempt >= CENTROID_CAS_ATTEMPTS) {
        throw error;
      }
      // 循环回去重读最近邻——事务已回滚，item 没插进去，重来一次是干净的。
    }
  }
}

/**
 * 按簇现有全部成员重算 `root_cause_auto`。
 *
 * **只写 auto 列**——人工判定（`root_cause_manual`）永不被覆盖（Global Constraint 8），
 * 读取一律 `COALESCE(manual, auto)`。
 *
 * `followUpRatio` 的分母**只算 `online`**（与读模型 `listClusters` 逐字一致，但**故意不同于**
 * `freq_30d` 的 `<> 'offline_run'`）：`follow_up_suspected` 只可能由收集器对 online 样本置真——
 * 手动入池的行恒为 false（拿不到 `contextPrecision`，也没有改写数据）。把恒不可能进分子的行
 * 放进分母只会**稀释**：3/3 的指代追问簇，人再手动补 4 条同题样本就成 3/7 = 0.43，
 * `triageCluster` 的强制 `retrieval` 覆写随即失效、根因翻回 `missing`
 * ⇒ 021 §6.4 要防的「把人力引去补一篇根本不缺的文档」恰好发生。**补证据反而让诊断变坏。**
 */
export async function recomputeRootCause(
  store: GapCollectorStore,
  clusterId: string,
  now: Date,
): Promise<void> {
  const inputs = await store.listClusterTriageInputs(clusterId);
  if (inputs.length === 0) return;
  const causes = inputs.map((i) =>
    triageItem({
      confidence: i.confidence,
      contextPrecision: i.contextPrecision,
      faithfulness: i.faithfulness,
    }),
  );
  const counted = inputs.filter((i) => i.source === "online");
  const followUpRatio =
    counted.length === 0 ? 0 : counted.filter((i) => i.followUpSuspected).length / counted.length;
  await store.setClusterRootCauseAuto(clusterId, triageCluster(causes, followUpRatio), now);
}


/**
 * 「复发」判定（原型 `:376` 边界表 / `:708` 状态机）：
 * 已终结的簇在 `RECURRENCE_WINDOW_DAYS` 天内新增 ≥ `RECURRENCE_MIN_ITEMS` 条 ⇒ 该重开。
 *
 * **只判不写**——返回布尔，重开这一步由调用方交给 `GapsService.reopenRecurred`
 * 走 TRANSITIONS 表（「一切迁移都过状态机」这条不变量若在第一个消费者身上就破例，
 * 它就不再是不变量了）。
 *
 * 非终结态**直接返回 false、一次库都不查**：绝大多数样本并入的是 `pending` 簇，
 * 每条都白跑一次 `count(*)` 会把收集器单轮的查询数直接翻倍，而它永远不可能触发。
 *
 * 与 `recomputeRootCause` 同住此文件（「收集器与手动入池共享的判定」之家），
 * 但**只由收集器调用**：原型那一行明写了 `(worker)`——人从 Trace 详情手动补一条样本
 * 不该顺带把他自己刚忽略掉的簇顶回待处理。
 */
export async function checkRecurrence(
  store: GapCollectorStore,
  clusterId: string,
  statusBeforeAttach: GapClusterStatus,
  terminalAt: Date | null,
  now: Date,
): Promise<boolean> {
  if (!GAP_TERMINAL_STATUSES.has(statusBeforeAttach)) return false;
  const rolling = new Date(now.getTime() - RECURRENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  /**
   * 窗口起点取「7 天前」与「进入终态那一刻」中**较晚**的一个。
   *
   * 原型 `:376`/`:708` 说的是「已回验**后** 7 天内新增 ≥5 条」——锚点是终态时刻。
   * 只按滚动 7 天数的话，会把簇**被忽略之前**攒下的样本也算进来：一个本周命中 6 次的热簇，
   * 运营刚点「忽略」，下一条样本进来计数就是 7 ≥ 5，立刻又被重开——
   * 「频次+1 但不重开」这条对**真正需要它的簇**永远不成立，[忽略] 等于没有（peer review P2）。
   *
   * `terminalAt` 为 null 只可能是迁移 0029 之前的历史行（回填已覆盖存量终态簇），
   * 退化成滚动窗口即老行为，不会更糟。
   */
  const windowStart =
    terminalAt && terminalAt > rolling ? terminalAt : rolling;
  const recent = await store.countRecentItems(clusterId, windowStart);
  return recent >= RECURRENCE_MIN_ITEMS;
}
