import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import type {
  QualitySignal,
  SessionListResponse,
  SessionListRow,
  SessionStatus,
  TraceDetailResponse,
  TraceListQuery,
  TraceListResponse,
  TraceListRow,
  TraceSpan,
  TraceStatus,
} from "@codecrush/contracts";
import { CLICKHOUSE } from "../../platform/clickhouse/clickhouse.constants";
import type { CodeCrushClickHouseClient } from "../../platform/clickhouse/clickhouse.types";

export const TRACE_VIEW_NAME = "codecrush_trace_spans";
export const TRACES_VIEW_NAME = "codecrush_traces";
export const SESSIONS_VIEW_NAME = "codecrush_sessions";
const TRACE_VIEW_SQL_RELPATH = join("infra", "clickhouse", "views", "001-trace-views.sql");

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

/**
 * 解析仓库根下的 VIEW SQL 路径。
 * 后端 `start` 经 `pnpm --filter @codecrush/backend start` 运行，cwd = apps/backend，
 * 直接用 process.cwd() 拼 infra/ 会指到 apps/backend/infra（不存在），所以从当前文件位置
 * 向上找 pnpm-workspace.yaml 标记的仓库根（dist 与 src 运行都成立）。
 */
function resolveTraceViewSqlPath(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return join(dir, TRACE_VIEW_SQL_RELPATH);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 兜底：cwd 相对（从仓库根启动时成立）
  return join(process.cwd(), TRACE_VIEW_SQL_RELPATH);
}

/**
 * ClickHouse DateTime64 经 JSONEachRow 默认返回 "YYYY-MM-DD hh:mm:ss[.fraction]"（UTC、无时区）。
 * 直接 `new Date(该串)` 会被当本地时区解析产生偏移；这里按 UTC 显式解析并规整到毫秒 ISO。
 */
function toIsoUtc(chTime: string): string {
  const m = chTime.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?/);
  if (!m) return new Date(chTime).toISOString();
  const frac = (m[3] ?? "").padEnd(3, "0").slice(0, 3);
  return new Date(`${m[1]}T${m[2]}.${frac}Z`).toISOString();
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
  attributes: Record<string, unknown>;
};

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
    const result = await this.clickhouse.query({
      query: "EXISTS TABLE otel_traces",
      format: "JSONEachRow",
    });
    const rows = await result.json<{ result: 0 | 1 }>();
    return rows[0]?.result === 1;
  }

  /**
   * 确保防腐 VIEW 存在。返回 false = exporter 还没建 otel_traces（冷库），
   * 调用方应返回空结果而不是等待/报错（review P3-3：原实现轮询 10s 后 500）。
   */
  async ensureTraceViews(): Promise<boolean> {
    if (this.viewsReady) return true;
    if (!(await this.exporterTableExists())) return false;
    const viewSql = await readFile(resolveTraceViewSqlPath(), "utf8");
    // @clickhouse/client 的 command 不支持一次多语句；按 `;` 切分逐条建 VIEW（顺序 = 文件序：traces 先于 sessions）。
    // 每段先剥掉整行注释（`-- …`）再判空——段首常有说明性注释行，不能整段丢弃。
    const statements = viewSql
      .split(";")
      .map((s) =>
        s
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join("\n")
          .trim(),
      )
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await this.clickhouse.command({ query: stmt });
    }
    this.viewsReady = true;
    return true;
  }

  async findByTraceId(traceId: string): Promise<TraceDetailResponse> {
    if (!(await this.ensureTraceViews())) {
      return { traceId, spans: [] };
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
    return {
      traceId,
      spans: rows.map(
        (row): TraceSpan => ({
          traceId: row.trace_id,
          spanId: row.span_id,
          parentSpanId: row.parent_span_id || null,
          name: row.name,
          kind: row.kind,
          startTime: toIsoUtc(row.start_time),
          durationMs: Number(row.duration_ms),
          statusCode: row.status_code,
          attributes: row.attributes ?? {},
        }),
      ),
    };
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
}
