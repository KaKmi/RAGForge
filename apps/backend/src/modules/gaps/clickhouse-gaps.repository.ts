import { Inject, Injectable } from "@nestjs/common";
import { CLICKHOUSE } from "../../platform/clickhouse/clickhouse.constants";
import type { CodeCrushClickHouseClient } from "../../platform/clickhouse/clickhouse.types";
import {
  loadSqlStatements,
  otelTracesTableExists,
  toIsoUtc,
} from "../../platform/clickhouse/clickhouse-view.utils";
import { POOL_CONFIDENCE_MAX, POOL_EVAL_SCORE_MAX } from "./gap.constants";

const TRACE_VIEW_SQL_RELPATH = "infra/clickhouse/views/001-trace-views.sql";
const EVAL_VIEW_SQL_RELPATH = "infra/clickhouse/views/003-eval-views.sql";

/**
 * judge-version 去重后的最新一次评分（口径与 `clickhouse-evaluations.repository.ts` 的
 * `LATEST_EVAL_SQL` 一致——同一条 trace 被多版判官评过时只取该版本的最后一次）。
 * `faithfulness` 的 -1 是「本次未评忠实度」的哨兵，必须还原成 NULL，不能当 0 分参与阈值比较。
 */
const LATEST_EVAL_SQL = `
  SELECT
    target_trace_id,
    judge_version,
    argMaxMerge(evaluated_at_state) AS evaluated_at,
    nullIf(argMaxMerge(faithfulness_state), -1) AS faithfulness,
    argMaxMerge(answer_relevancy_state) AS answer_relevancy,
    argMaxMerge(context_precision_state) AS context_precision
  FROM codecrush_eval_targets
  GROUP BY target_trace_id, judge_version
`;

/**
 * 改写后的问题取自 rewrite 子 span（决策 G）。
 *
 * 用**既有**的 `codecrush_trace_spans` 视图——它已把每个 span 的完整 `SpanAttributes`
 * 投影为 `attributes`，所以不需要（本波也不允许）新建任何视图。
 * `rag.node.name = 'rewrite'` 已在真库上核对过：实际取值就是 `rewrite`。
 *
 * 读的是**一等属性** `rag.rewrite.query`（`RAG.REWRITE_QUERY`），不是从
 * `codecrush.io.output` 解 JSON —— 后者压根没打在 rewrite 子 span 上（只在 chain 根 span
 * 与 rag.eval span 上），实测 198 条 rewrite span 里 0 条带它。B2a 已在 chat 编排的
 * rewrite 节点补了 `spanEnrich`（与 intent 节点同款做法），这里直接取即可。
 *
 * ⚠️ 埋点是本次才加的：**在此之前产生的历史 trace 没有这个属性**，取到空串 ⇒
 * `rewrittenQuestion` 为 null ⇒ 应用层按「指代未消解」处理。这对历史数据是安全的默认
 * （宁可标记为待人工改写，也不要把答不对的题沉淀成 gold），新流量则自动正常。
 */
const REWRITE_SPAN_SQL = `
  SELECT
    trace_id,
    argMax(attributes['rag.rewrite.query'], start_time) AS rewritten_question
  FROM codecrush_trace_spans
  WHERE attributes['rag.node.name'] = 'rewrite'
  GROUP BY trace_id
`;

/**
 * 游标。`lastTs` 是**不透明的原始 CH 时间串**，不是 `Date`。
 *
 * 因为排序键 `start_time` 是 `DateTime64(9)`（纳秒），而 JS `Date` 只到毫秒：
 * 一旦把 `...123456789` 截成 `...123`，元组比较 `(123456789, id) > (123000000, id)`
 * 仍然成立 ⇒ **该行每页都被重新取出，游标永远推不过它**（分页死循环 / 每轮重复收集）。
 * 所以整条链路只传递原样字符串，中途不经 `Date`。
 */
export interface GapPoolCursor {
  lastTs: string;
  lastTraceId: string;
}

/** 首次运行（还没有水位线）时的游标起点。 */
export const GAP_POOL_CURSOR_START: GapPoolCursor = {
  lastTs: "1970-01-01 00:00:00.000000000",
  lastTraceId: "",
};

export interface PoolCandidate {
  traceId: string;
  question: string;
  rewrittenQuestion: string | null;
  /** 展示/落库用的 ISO 串（毫秒精度）。**不要拿它当游标**——见 `cursorTs`。 */
  startTime: string;
  /**
   * 原样的 CH `start_time`（纳秒精度），**只用于推进游标**。
   * 收集器处理完一批后应把最后一行的 `{cursorTs, traceId}` 写回水位线。
   */
  cursorTs: string;
  sessionId: string;
  isFirstTurnInSession: boolean;
  /**
   * **百分制（0–100）**，已在本 repository 换算过——遥测里它是 0–1。
   * 域内其余一切（`POOL_CONFIDENCE_MAX`、`shouldEnterPool`、`triageItem`、
   * `gap_items.confidence` 的 0–100 CHECK）都是百分制，量纲的接缝只此一处。
   */
  confidence: number | null;
  fallbackUsed: boolean;
  noCitations: boolean;
  faithfulness: number | null;
  answerRelevancy: number | null;
  contextPrecision: number | null;
}

type CandidateRow = {
  trace_id: string;
  question: string;
  rewritten_question: string | null;
  start_time: string;
  session_id: string;
  is_first_turn: number | boolean | string;
  confidence: number | string | null;
  // 视图里**没有** fallback_used 列，兜底折在 status 里；别名刻意避开这个名字，
  // 免得后来的人以为可以直接 `SELECT fallback_used`。
  is_fallback: number | boolean | string;
  no_citations: number | boolean | string;
  /** LEFT JOIN 是否命中评分。见 join_use_nulls 注释：不能靠分数列是否为 0 反推。 */
  has_eval: number | boolean | string;
  faithfulness: number | string | null;
  answer_relevancy: number | string | null;
  context_precision: number | string | null;
};

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function nullableNumber(value: number | string | null): number | null {
  if (value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toClickHouseDateTime(value: Date): string {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

/**
 * 单位换算：`POOL_CONFIDENCE_MAX` 沿用原型 `:378` 的百分制（「可信度 <60」），
 * 但 `rag.quality.confidence` 落的是 **0–1**——`deriveConfidence` 就是取召回分的
 * `Math.max`（`chat/derived-metrics.ts:11`），真库实测 39 条 trace 里 13 条有值、
 * 全落在 0.20–0.94，`avg = 0.7`。
 *
 * 若直接拿 0–1 的列去比 60，**每一条埋了可信度的 trace 都恒 <60** ⇒ 问题池被灌满。
 * 这与 `OrNull` 想拦的是同一类事故，只是走的是「量纲不一致」这条路。
 * 换算放在这里而不是改常量：常量是产品语义（百分制阈值，将来要上设置面板），
 * 0–1 是遥测的实现细节，二者的接缝就在本 repository。
 */
function toTelemetryConfidenceScale(percentThreshold: number): number {
  return percentThreshold / 100;
}

/**
 * 同一条接缝的另一端：**读出来的值**也要从 0–1 换回百分制再交给域内。
 *
 * 只换阈值、不换取值是半个修复，而且是危险的那半：`shouldEnterPool` / `triageItem` 拿
 * 0–1 的值去比 `POOL_CONFIDENCE_MAX = 60`，**每一条都判「可信度低」**——TS 侧的入池复判
 * 与根因分诊双双失效（复判恒放行，分诊恒往 `missing` 那一档偏）。且 `gap_items.confidence`
 * 的 `BETWEEN 0 AND 100` CHECK 拦不住它：0.3 也在区间里，只会静默存成一个假的低分。
 */
function toPercentConfidence(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100);
}

function toCandidate(row: CandidateRow): PoolCandidate {
  const rewritten = (row.rewritten_question ?? "").trim();
  const hasEval = truthy(row.has_eval);
  return {
    traceId: row.trace_id,
    question: row.question ?? "",
    // 空串与解析失败一律 null——「改写没取到」和「改写成了空」在下游是同一件事：未消解。
    rewrittenQuestion: rewritten === "" ? null : rewritten,
    startTime: toIsoUtc(row.start_time),
    // 原样保留，不经 Date/toIsoUtc —— 那两者都会把纳秒截到毫秒，游标就再也推不过该行。
    cursorTs: row.start_time,
    sessionId: row.session_id ?? "",
    isFirstTurnInSession: truthy(row.is_first_turn),
    confidence: toPercentConfidence(nullableNumber(row.confidence)),
    fallbackUsed: truthy(row.is_fallback),
    noCitations: truthy(row.no_citations),
    // 没评过分就一律 null，绝不把 0 当成「0 分」往下游传（Global Constraint 6 的读侧同源要求）。
    // join_use_nulls 已保证落空为 NULL，这里再按 has_eval 兜一道：那个设置若被谁改回默认，
    // SQL 文本断言是发现不了的，而这一行能让错误停在 repository 边界而不是流进聚类。
    faithfulness: hasEval ? nullableNumber(row.faithfulness) : null,
    answerRelevancy: hasEval ? nullableNumber(row.answer_relevancy) : null,
    contextPrecision: hasEval ? nullableNumber(row.context_precision) : null,
  };
}

/**
 * 问题池收集器的取数口径（021 §10 / 决策 G）。
 *
 * 与 evaluations 域一样自持一个 CH repository，而不是 `gaps → traces`：
 * 跨域只走各自的读模型，见 `003`「E-W1 evaluations 域边界」。
 */
@Injectable()
export class ClickHouseGapsRepository {
  private evalViewsReady = false;

  constructor(@Inject(CLICKHOUSE) private readonly clickhouse: CodeCrushClickHouseClient) {}

  private async ensureViews(): Promise<boolean> {
    if (this.evalViewsReady) return true;
    if (!(await otelTracesTableExists(this.clickhouse))) return false;
    for (const relPath of [TRACE_VIEW_SQL_RELPATH, EVAL_VIEW_SQL_RELPATH]) {
      for (const statement of await loadSqlStatements(relPath)) {
        await this.clickhouse.command({ query: statement });
      }
    }
    this.evalViewsReady = true;
    return true;
  }

  /**
   * 按游标向前扫一页入池候选。
   *
   * 谓词上的几个非显然取舍：
   * - `t.preview = 0` **显式写死**（Global Constraint 10）。不能靠「只有在线 trace 才有 rag.eval
   *   span」这条间接性质——入池阈值里 `status='fallback'` / `no_citations` 两支根本不经过 eval，
   *   一条预览重放的兜底 trace 会直接漏进池子。
   * - `t.confidence IS NOT NULL` 必须在 `<` 之前：没埋到可信度的 trace **不是**低可信度。
   *   （视图侧用 `toFloat64OrNull` 同理——落 0 会把每条没埋点的 trace 判成 <60。）
   * - `ifNull(latest.faithfulness, 101)` 是「未评忠实度」的哨兵：101 恒大于任何阈值，
   *   于是 `least(...)` 只在真的评过的维度上取最小，未评的维度不会假装成 0 分把 trace 拉进池。
   * - 严格元组游标 + `ORDER BY` 同键：保证游标单调前进，同一秒内的多条 trace 不会被跳过或重放。
   */
  async listPoolCandidates(
    cursor: GapPoolCursor,
    upperBound: Date,
    judgeVersion: string,
    limit: number,
  ): Promise<PoolCandidate[]> {
    if (!(await this.ensureViews())) return [];
    const result = await this.clickhouse.query({
      query: `
        SELECT
          t.trace_id AS trace_id,
          t.user_input AS question,
          rw.rewritten_question AS rewritten_question,
          t.start_time AS start_time,
          t.session_id AS session_id,
          (t.session_id = '' OR t.start_time = firstTurn.first_ts) AS is_first_turn,
          t.confidence AS confidence,
          t.status = 'fallback' AS is_fallback,
          t.no_citations AS no_citations,
          latest.target_trace_id != '' AS has_eval,
          latest.faithfulness AS faithfulness,
          latest.answer_relevancy AS answer_relevancy,
          latest.context_precision AS context_precision
        FROM codecrush_traces AS t
        LEFT JOIN (${LATEST_EVAL_SQL}) AS latest
          ON t.trace_id = latest.target_trace_id
          AND latest.judge_version = {judgeVersion:String}
        LEFT JOIN (${REWRITE_SPAN_SQL}) AS rw ON rw.trace_id = t.trace_id
        LEFT JOIN (
          SELECT session_id, min(start_time) AS first_ts
          FROM codecrush_traces
          WHERE preview = 0 AND session_id != ''
          GROUP BY session_id
        ) AS firstTurn ON firstTurn.session_id = t.session_id
        WHERE t.preview = 0
          AND (t.start_time, t.trace_id) > ({lastTs:DateTime64(9)}, {lastTraceId:String})
          AND t.start_time <= {upperBound:DateTime64(9)}
          AND (
            (t.confidence IS NOT NULL AND t.confidence < {confidenceMax:Float64})
            OR t.status = 'fallback'
            OR t.no_citations = 1
            OR (
              -- 必须先确认这条 trace 真被判过分再比阈值。见下方 join_use_nulls 注释：
              -- 没有这个守卫时，未评分 trace 的分数列会是 0 而不是 NULL，
              -- least(101, 0, 0) < 70 恒真 ⇒ 前三个分支全成死代码、整条流量灌进池子。
              latest.target_trace_id != ''
              AND least(
                    ifNull(latest.faithfulness, 101),
                    ifNull(latest.answer_relevancy, 101),
                    ifNull(latest.context_precision, 101)
                  ) < {evalMax:Float64}
            )
          )
        ORDER BY t.start_time ASC, t.trace_id ASC
        LIMIT {limit:UInt32}
      `,
      query_params: {
        lastTs: cursor.lastTs,
        lastTraceId: cursor.lastTraceId,
        upperBound: toClickHouseDateTime(upperBound),
        judgeVersion,
        confidenceMax: toTelemetryConfidenceScale(POOL_CONFIDENCE_MAX),
        evalMax: POOL_EVAL_SCORE_MAX,
        limit,
      },
      /**
       * **必须显式开** —— ClickHouse 的 `join_use_nulls` 默认是 `0`，LEFT JOIN 落空时
       * 右表列填的是**类型默认值**而不是 NULL。`LATEST_EVAL_SQL` 里 `faithfulness` 有
       * `nullIf(...)` 包着（`Nullable(Float64)`，落空得 NULL，`ifNull(...,101)` 哨兵有效），
       * 但 `answer_relevancy` / `context_precision` 是裸的 `argMaxMerge`（非 Nullable Float64）
       * ⇒ 落空得 **0**。于是 `least(101, 0, 0) < 70` 对**每一条没评过分的 trace** 恒真，
       * 入池阈值的前三个分支变成死代码，整条非 preview 流量被灌进问题池。
       *
       * 开了它，落空一律 NULL：WHERE 里 `NULL < 70` 求值为 NULL（不成立），
       * 投影侧也不会把「没评过」读成 0 分（Global Constraint 6 的读侧同源要求）。
       * 上面的 `latest.target_trace_id != ''` 守卫是第二道——两道都留着，
       * 因为这个设置一旦被谁在别处改回默认，靠 SQL 文本断言是发现不了的。
       */
      clickhouse_settings: { join_use_nulls: 1 },
      format: "JSONEachRow",
    });
    const rows = await result.json<CandidateRow>();
    return rows.map(toCandidate);
  }
}
