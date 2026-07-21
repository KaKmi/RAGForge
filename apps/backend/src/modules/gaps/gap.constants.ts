/**
 * 问题池的全部阈值常量（021 §10 / 决策 C·F）。
 *
 * 阈值**集中在此、不散写字面量**：原型 `:378` 写「可配」，但 §17.5 的组件清单里没有设置抽屉
 * ——加一张只有一行、UI 摸不到的设置表是投机（021「已知取舍」1）。B2b 若加设置面板再建表，
 * 届时这些常量变成默认值即可。
 */

/** 入池阈值：可信度低于此值即入池（原型 `:378`「可信度 <60」）。 */
export const POOL_CONFIDENCE_MAX = 60;

/** 入池阈值：eval 三分任一低于此值即入池（原型 `:378`「eval 任一分 <70」）。 */
export const POOL_EVAL_SCORE_MAX = 70;

/**
 * 归簇阈值：embedding 余弦 ≥ 此值归入既有簇，否则建新簇（原型 `:379`「≥0.85，常量起步」）。
 * 真实数据上大概率要调——调它只改这一处。
 */
export const CLUSTER_SIMILARITY_MIN = 0.85;

/**
 * 「指代追问」判据之一：精确率 ≤ 此值才算近乎零召回（021 §6.4）。
 * 与 `rewrite_resolved === false` 取合取——单独任一条都会误伤。
 */
export const FOLLOWUP_PRECISION_MAX = 10;

/**
 * 簇级强制分诊阈值：`follow_up_ratio` **严格大于**此值时，`root_cause_auto` 强制为
 * `retrieval`、永不判 `missing`（021 §6.4 的结构性免疫）。严格大于 ⇒ 恰好 0.5 不触发。
 */
export const FOLLOWUP_RATIO_MIN = 0.5;

/** 入集重复检测：与目标集既有用例相似度 > 此值时标「疑似重复」（原型 `:269`），用户仍可强制加入。 */
export const DUPLICATE_SIMILARITY_MIN = 0.95;

/**
 * 入集重复检测的**跨集比对上限**：目标集用例数超过此值时，只与**前 N 条**比对。
 *
 * 021 §12② 当初把语义近似这一半降级掉，理由正是「跨集比对要把目标集全部用例 embed 一遍，
 * 成本随集大小线性增长」——一次 promote 顶多 50 条候选，却可能拖着一个上千条的目标集去 embed。
 * 封顶把单次成本钉死在 `50 + N` 个文本，与目标集规模脱钩。
 *
 * 代价是**漏检**（第 N+1 条之后的近似用例查不到），所以截断这件事**必须回给调用方**
 * （`PromoteGapResponse.duplicateCheckTruncated`）——静默截断会让「没有 warning」
 * 被当成「集里确实没有重复」。与 `GAP_COLLECT_CANDIDATE_LIMIT` 同列于此：都是成本旋钮。
 */
export const DUPLICATE_COMPARE_CASE_LIMIT = 200;

/** 滚动频次窗口天数（原型 `:377`，与 trace TTL 30 天对齐）。 */
export const FREQ_WINDOW_DAYS = 30;

/**
 * 缺口簇状态（B2b 全七态）。
 *
 * ⚠️ **三处独立声明必须同步**（不是互相 re-export，改一处不会带动另外两处）：
 * 本常量 → `gaps.service.ts` 的 `TRANSITIONS` 表按它做类型约束；
 * `packages/contracts/src/gaps.ts:GAP_CLUSTER_STATUSES` → 前端与 API 契约；
 * `schema.ts` 的 `gap_clusters_status_check` → DB 值域（迁移 0028）。
 * 少同步任何一处的后果：service 判定合法但 DB 拒绝（500），或前端拿到解析不了的枚举值。
 */
export const GAP_CLUSTER_STATUSES = [
  "pending",
  "routed_retrieval",
  "ignored",
  "drafting",
  "reviewing",
  "filled",
  "verified",
] as const;
export type GapClusterStatus = (typeof GAP_CLUSTER_STATUSES)[number];

/** 「复发」判定窗口（原型 `:376`/`:708`：「7 天内新增 ≥5 条」）。 */
export const RECURRENCE_WINDOW_DAYS = 7;

/** 「复发」判定阈值：窗口内新增相似样本达到此数，已终结的簇自动重开为 `pending` + 复发标。 */
export const RECURRENCE_MIN_ITEMS = 5;

/** 回验通过阈值（原型 `:370`：「新分数 ≥80 → 已回验✓」）。 */
export const VERIFY_PASS_THRESHOLD = 80;

/**
 * 质心 CAS 冲突后的**总尝试次数**（首次 + 重试；021 §12② 的收口）。
 *
 * 冲突要求两个实例在租约超时窗口内并发处理同一个簇，极罕见；试到这个数还撞说明是持续的
 * 高并发写入，此时让它冒泡比原地打转好。与 `GAP_COLLECT_*` 同列于此，是因为它和租约时长、
 * 单批上限一样属于「收集器的运行机制旋钮」，不是散写的魔法数字。
 */
export const CENTROID_CAS_ATTEMPTS = 3;

/** 根因分诊三值（原型 `:371`）。 */
export const GAP_ROOT_CAUSES = ["missing", "retrieval", "generation"] as const;
export type GapRootCause = (typeof GAP_ROOT_CAUSES)[number];

/**
 * 入池来源。`offline_run` 不计入 `freq_30d`（021 决策 D）——它是离线重跑的产物，
 * 不是真实用户流量；而 `manual_trace` 是人从 Trace 详情挑的**真实线上 trace**，要计入。
 */
export const GAP_ITEM_SOURCES = ["online", "manual_trace", "offline_run"] as const;
export type GapItemSource = (typeof GAP_ITEM_SOURCES)[number];

/** 收集器 worker 名（`gap_watermarks` 主键）。 */
export const GAP_COLLECT_WORKER_NAME = "gap-collect-v1";

/** 收集器租约时长。取值同 `EVALUATION_LEASE_MS`：够一轮跑完，又短到崩溃后很快能被接管。 */
export const GAP_COLLECT_LEASE_MS = 10 * 60 * 1000;

/** 单轮最多处理多少条候选。每条要发一次 embedding + 一次最近邻，故比在线评测的批小一档。 */
export const GAP_COLLECT_CANDIDATE_LIMIT = 200;

/**
 * 取数上界的滞后缓冲：只看 `now - 缓冲` 之前的 trace。
 * 在线评测 span 是 trace 结束后异步补写的，紧贴 now 取会读到**还没被评分**的 trace，
 * 它们只凭 confidence/fallback 入池，分数列恒 NULL ⇒ 分诊只能兜底判 `missing`，
 * 而游标已经越过、永不回头重看。宁可晚 15 分钟拿到完整信号。
 */
export const GAP_COLLECT_LAG_BUFFER_MS = 15 * 60 * 1000;

/** 收集节奏。比在线评测（*\/15）慢一档——问题池是趋势看板，不需要准实时。 */
export const GAP_COLLECT_CRON = "*/30 * * * *";

/**
 * 「已终结」的两个状态——复发判定只对它们生效（原型 `:376`/`:708`：
 * 「已入库/已忽略的簇再收到相似问题只涨频次不重开；已回验后 7 天内 ≥5 条才重开」）。
 * 进入其一时记 `terminal_at` 作为那个 7 天窗口的起点。
 *
 * ⚠️ **必须只有这一份**。它同时驱动一件事的两端：`applyTransition` 据它决定何时盖
 * `terminal_at` 锚点（写侧），`checkRecurrence` 据它决定要不要查库判复发（读侧）。
 * 清理复审三位独立指出：B2b 初版在 `gaps.service.ts` 与 `gap-ingest.ts` 各写了一份，
 * 类型还不同（`Set<GapClusterStatus>` vs `readonly string[]`）。真出事的方式是静默的——
 * 将来加第八个终态只改写侧，锚点照打而复发判定永远返回 false，
 * 「复发功能对新状态失效」不会让任何测试变红。
 */
export const GAP_TERMINAL_STATUSES = new Set<GapClusterStatus>(["ignored", "verified"]);
