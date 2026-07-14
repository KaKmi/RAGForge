import { Inject, Injectable } from "@nestjs/common";
import type {
  QualitySignal,
  SessionDetailResponse,
  SessionListResponse,
  SessionListRow,
  SessionRound,
  SessionStatus,
  TraceDetailMeta,
  TraceDetailResponse,
  TraceListQuery,
  TraceListResponse,
  TraceListRow,
  TraceSpan,
  TraceStatus,
} from "@codecrush/contracts";
import { GEN_AI } from "@codecrush/otel-conventions";
import { CLICKHOUSE } from "../../platform/clickhouse/clickhouse.constants";
import type { CodeCrushClickHouseClient } from "../../platform/clickhouse/clickhouse.types";
import { loadSqlStatements, otelTracesTableExists, toIsoUtc } from "./clickhouse-view.utils";

export const TRACE_VIEW_NAME = "codecrush_trace_spans";
export const TRACES_VIEW_NAME = "codecrush_traces";
export const SESSIONS_VIEW_NAME = "codecrush_sessions";
const TRACE_VIEW_SQL_RELPATH = "infra/clickhouse/views/001-trace-views.sql";

/** quick=慢请求 的耗时阈值（ms）；对齐前端 mock（≥3s）与 P95 红线 5s 分离。 */
const SLOW_MS = 3000;

/** 中文状态筛选 → CH 英文 token（响应/存储统一英文，query 用中文对齐前端筛选值）。 */
const STATUS_ZH_TO_TOKEN: Record<string, TraceStatus> = {
  成功: "success",
  兜底: "fallback",
  失败: "failed",
};

/** ClickHouse Bool/UInt8 经 JSONEachRow 可能是 0/1 或 true/false，统一判真。 */
function chTruthy(v: unknown): boolean {
  return v === 1 || v === true || v === "1" || v === "true";
}

type ClickHouseTraceRow = {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: string;
  start_time: string;
  duration_ms: number;
  status_code: string;
  status_message: string;
  attributes: Record<string, unknown>;
};

/** 冷库/无 root 兜底的零值 meta（仍满足契约）。 */
export const EMPTY_TRACE_META: TraceDetailMeta = {
  userInput: "",
  agentName: null,
  genModel: null,
  genModelVersion: null,
  promptVersionId: null,
  durationMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  cost: null,
  status: "success",
  qualitySignals: [],
};

/** 从 span 属性（Map(String,String) 字符串值）拼质量信号数组——同 W1 mapTraceRow 语义。 */
function signalsFromAttrs(a: Record<string, unknown>): QualitySignal[] {
  const out: QualitySignal[] = [];
  if (chTruthy(a["rag.quality.low_recall"])) out.push("low_recall");
  if (chTruthy(a["rag.quality.no_citations"])) out.push("no_citations");
  if (chTruthy(a["rag.quality.refusal"])) out.push("refusal");
  if (chTruthy(a["rag.quality.timeout"])) out.push("timeout");
  return out;
}

/**
 * 从已取 spans 纯 TS 聚合详情 meta（不发第二条 CH 查询）。
 * root = kind='chain' 的 RAG 一轮根 span。注意：HTTP 自动埋点使 chain span 有 HTTP server 父
 * （ParentSpanId≠''），故不能用 parentSpanId===null 认根——chain 才是 RAG 语义根。
 */
function buildTraceMeta(spans: TraceSpan[]): TraceDetailMeta {
  const root = spans.find((s) => s.kind === "chain") ?? spans.find((s) => s.parentSpanId === null);
  if (!root) return EMPTY_TRACE_META;
  const a = root.attributes as Record<string, unknown>;
  const isError = root.statusCode === "Error" || root.statusCode === "STATUS_CODE_ERROR";
  const status: TraceStatus = isError
    ? "failed"
    : chTruthy(a["rag.fallback.used"])
      ? "fallback"
      : "success";
  const reply = spans.find(
    (s) => s.kind === "llm" && (s.attributes as Record<string, unknown>)["rag.node.name"] === "reply",
  );
  const lastLlm = [...spans].reverse().find((s) => s.kind === "llm");
  const rootGenModel = a[GEN_AI.REQUEST_MODEL];
  const genModel =
    typeof rootGenModel === "string" && rootGenModel.length > 0
      ? rootGenModel
      : ((reply ?? lastLlm)?.attributes as Record<string, unknown> | undefined)?.[
          GEN_AI.REQUEST_MODEL
        ];
  const traceTokens = (key: string): number => {
    const rootValue = a[key];
    if (rootValue !== undefined && rootValue !== null && rootValue !== "") {
      return Number(rootValue);
    }
    return spans.reduce(
      (sum, s) =>
        s.kind === "llm"
          ? sum + Number((s.attributes as Record<string, unknown>)[key] ?? 0)
          : sum,
      0,
    );
  };
  return {
    userInput: String(a["codecrush.io.input"] ?? ""),
    agentName: (a["gen_ai.agent.name"] as string) || null,
    genModel: (genModel as string) || null,
    genModelVersion: null,
    promptVersionId: (a["rag.prompt.version_id"] as string) || null,
    durationMs: root.durationMs,
    inputTokens: traceTokens(GEN_AI.USAGE_INPUT_TOKENS),
    outputTokens: traceTokens(GEN_AI.USAGE_OUTPUT_TOKENS),
    cost: null,
    status,
    qualitySignals: signalsFromAttrs(a),
  };
}

// codecrush_traces / codecrush_sessions VIEW 行（值经 JSONEachRow：数字可能是 string，Bool 可能 0/1 或 true/false）
type TracesViewRow = {
  trace_id: string;
  session_id: string;
  agent_id: string;
  agent_name: string;
  user_id: string;
  user_input: string;
  output: string;
  start_time: string;
  total_duration_ms: number | string;
  total_input_tokens: number | string | null;
  total_output_tokens: number | string | null;
  status: TraceStatus;
  low_recall: unknown;
  no_citations: unknown;
  refusal: unknown;
  timeout: unknown;
  prompt_version_id: string;
  preview: unknown;
};
type SummaryRow = {
  total: number | string;
  failCount: number | string;
  p95Ms: number | string;
  timeoutCount: number | string;
};
type SessionsViewRow = {
  session_id: string;
  user_id: string;
  agent_id: string;
  agent_name: string;
  round_count: number | string;
  first_question: string;
  first_ts: string;
  last_ts: string;
  status: SessionStatus;
};

function mapTraceRow(r: TracesViewRow): TraceListRow {
  const signals: QualitySignal[] = [];
  if (chTruthy(r.low_recall)) signals.push("low_recall");
  if (chTruthy(r.no_citations)) signals.push("no_citations");
  if (chTruthy(r.refusal)) signals.push("refusal");
  if (chTruthy(r.timeout)) signals.push("timeout");
  return {
    traceId: r.trace_id,
    sessionId: r.session_id ?? "",
    agentId: r.agent_id ?? "",
    agentName: r.agent_name ?? "",
    userId: r.user_id ? r.user_id : null,
    userInput: r.user_input ?? "",
    status: r.status,
    startTime: toIsoUtc(r.start_time),
    durationMs: Number(r.total_duration_ms ?? 0),
    inputTokens: Number(r.total_input_tokens ?? 0),
    outputTokens: Number(r.total_output_tokens ?? 0),
    qualitySignals: signals,
    promptVersionId: r.prompt_version_id ? r.prompt_version_id : null,
  };
}

function mapSessionRow(r: SessionsViewRow): SessionListRow {
  return {
    sessionId: r.session_id,
    userId: r.user_id ? r.user_id : null,
    agentId: r.agent_id ?? "",
    agentName: r.agent_name ?? "",
    roundCount: Number(r.round_count ?? 0),
    firstQuestion: r.first_question ?? "",
    firstTs: toIsoUtc(r.first_ts),
    lastTs: toIsoUtc(r.last_ts),
    status: r.status,
  };
}

@Injectable()
export class ClickHouseTracesRepository {
  /** VIEW 已确认建好后置位，读路径不再重复 readFile + DDL（review P3-3） */
  private viewsReady = false;

  constructor(@Inject(CLICKHOUSE) private readonly clickhouse: CodeCrushClickHouseClient) {}

  private async exporterTableExists(): Promise<boolean> {
    return otelTracesTableExists(this.clickhouse);
  }

  /**
   * 确保防腐 VIEW 存在。返回 false = exporter 还没建 otel_traces（冷库），
   * 调用方应返回空结果而不是等待/报错（review P3-3：原实现轮询 10s 后 500）。
   */
  async ensureTraceViews(): Promise<boolean> {
    if (this.viewsReady) return true;
    if (!(await this.exporterTableExists())) return false;
    // @clickhouse/client 的 command 不支持一次多语句；按 `;` 切分逐条建 VIEW（顺序 = 文件序：traces 先于 sessions）。
    // 每段先剥掉整行注释（`-- …`）再判空——段首常有说明性注释行，不能整段丢弃。
    const statements = await loadSqlStatements(TRACE_VIEW_SQL_RELPATH);
    for (const stmt of statements) {
      await this.clickhouse.command({ query: stmt });
    }
    this.viewsReady = true;
    return true;
  }

  async findByTraceId(traceId: string): Promise<TraceDetailResponse> {
    if (!(await this.ensureTraceViews())) {
      return { traceId, meta: EMPTY_TRACE_META, spans: [] };
    }
    const result = await this.clickhouse.query({
      query: `
        SELECT *
        FROM ${TRACE_VIEW_NAME}
        WHERE trace_id = {traceId:String}
        ORDER BY start_time ASC
      `,
      query_params: { traceId },
      format: "JSONEachRow",
    });
    const rows = await result.json<ClickHouseTraceRow>();
    const spans = rows.map(
      (row): TraceSpan => ({
        traceId: row.trace_id,
        spanId: row.span_id,
        parentSpanId: row.parent_span_id || null,
        name: row.name,
        kind: row.kind,
        startTime: toIsoUtc(row.start_time),
        durationMs: Number(row.duration_ms),
        statusCode: row.status_code,
        statusMessage: row.status_message || null,
        attributes: row.attributes ?? {},
      }),
    );
    return { traceId, meta: buildTraceMeta(spans), spans };
  }

  private async runView<T>(query: string, params: Record<string, unknown>): Promise<T[]> {
    const result = await this.clickhouse.query({ query, query_params: params, format: "JSONEachRow" });
    return await result.json<T>();
  }

  /** 组 WHERE：始终排除 preview（试运行不入正式统计）+ 按 query 追加筛选，全走 query_params 防注入。 */
  private buildTraceWhere(q: TraceListQuery): { where: string; params: Record<string, unknown> } {
    const conds: string[] = ["preview = 0"];
    const params: Record<string, unknown> = {};
    if (q.agentId) {
      conds.push("agent_id = {agentId:String}");
      params.agentId = q.agentId;
    }
    if (q.status && q.status !== "全部") {
      conds.push("status = {status:String}");
      params.status = STATUS_ZH_TO_TOKEN[q.status];
    }
    if (q.quick && q.quick !== "全部") {
      if (q.quick === "失败") conds.push("status = 'failed'");
      else if (q.quick === "慢请求") {
        conds.push("total_duration_ms >= {slow:UInt32}");
        params.slow = SLOW_MS;
      } else if (q.quick === "低分召回") conds.push("low_recall");
    }
    if (q.q) {
      conds.push("(user_input ILIKE {kw:String} OR trace_id ILIKE {kw:String})");
      params.kw = `%${q.q}%`;
    }
    if (q.from) {
      conds.push("start_time >= parseDateTimeBestEffortOrNull({from:String})");
      params.from = q.from;
    }
    if (q.to) {
      conds.push("start_time <= parseDateTimeBestEffortOrNull({to:String})");
      params.to = q.to;
    }
    return { where: `WHERE ${conds.join(" AND ")}`, params };
  }

  async listTraces(q: TraceListQuery): Promise<TraceListResponse> {
    const empty: TraceListResponse = {
      items: [],
      total: 0,
      summary: { sampledTotal: 0, failRate: 0, failCount: 0, p95Ms: 0, timeoutCount: 0 },
    };
    if (!(await this.ensureTraceViews())) return empty;
    const { where, params } = this.buildTraceWhere(q);
    const offset = (q.page - 1) * q.pageSize;
    const rows = await this.runView<TracesViewRow>(
      `SELECT * FROM ${TRACES_VIEW_NAME} ${where} ORDER BY start_time DESC LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
      { ...params, limit: q.pageSize, offset },
    );
    const [agg] = await this.runView<SummaryRow>(
      `SELECT count() AS total, countIf(status = 'failed') AS failCount,
              quantile(0.95)(total_duration_ms) AS p95Ms, countIf(timeout) AS timeoutCount
       FROM ${TRACES_VIEW_NAME} ${where}`,
      params,
    );
    const total = Number(agg?.total ?? 0);
    const failCount = Number(agg?.failCount ?? 0);
    const p95 = Number(agg?.p95Ms ?? 0);
    return {
      items: rows.map(mapTraceRow),
      total,
      summary: {
        sampledTotal: total,
        failCount,
        failRate: total ? failCount / total : 0,
        p95Ms: Number.isFinite(p95) ? p95 : 0,
        timeoutCount: Number(agg?.timeoutCount ?? 0),
      },
    };
  }

  async listSessions(): Promise<SessionListResponse> {
    if (!(await this.ensureTraceViews())) return [];
    const rows = await this.runView<SessionsViewRow>(
      `SELECT * FROM ${SESSIONS_VIEW_NAME} ORDER BY last_ts DESC`,
      {},
    );
    return rows.map(mapSessionRow);
  }

  /**
   * M9 W3：Session 详情 = 该会话所有正式 trace（排除 preview）按时间升序，每行一轮。
   * 直接复用 codecrush_traces VIEW（已含 output/user_input/status/duration），无需第二个 VIEW。
   * 冷库/未落库返回空 rounds（页面占位）。
   */
  async findSessionById(sessionId: string): Promise<SessionDetailResponse> {
    const empty: SessionDetailResponse = { sessionId, userId: null, agentId: "", agentName: "", rounds: [] };
    if (!(await this.ensureTraceViews())) return empty;
    const rows = await this.runView<TracesViewRow>(
      `SELECT * FROM ${TRACES_VIEW_NAME} WHERE session_id = {sid:String} AND preview = 0 ORDER BY start_time ASC`,
      { sid: sessionId },
    );
    const rounds: SessionRound[] = rows.map((r) => ({
      traceId: r.trace_id,
      userInput: r.user_input ?? "",
      output: r.output ?? "",
      status: r.status,
      durationMs: Number(r.total_duration_ms ?? 0),
      startTime: toIsoUtc(r.start_time),
    }));
    const first = rows[0];
    return {
      sessionId,
      userId: first?.user_id ? first.user_id : null,
      agentId: first?.agent_id ?? "",
      agentName: first?.agent_name ?? "",
      rounds,
    };
  }
}
