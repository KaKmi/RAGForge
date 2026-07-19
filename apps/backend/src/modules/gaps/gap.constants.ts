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

/** 滚动频次窗口天数（原型 `:377`，与 trace TTL 30 天对齐）。 */
export const FREQ_WINDOW_DAYS = 30;

/** 缺口簇状态（B2a 可达子集；B2b 加四态时须同步 ALTER `gap_clusters_status_check`）。 */
export const GAP_CLUSTER_STATUSES = ["pending", "routed_retrieval", "ignored"] as const;
export type GapClusterStatus = (typeof GAP_CLUSTER_STATUSES)[number];

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
