import { Alert, Button, DatePicker, Input, Select, Space, Spin, Tooltip, message } from "antd";
import { ApiOutlined, ClockCircleOutlined, DollarOutlined, DownloadOutlined, FallOutlined, MessageOutlined, QuestionCircleOutlined, RiseOutlined, ThunderboltOutlined } from "@ant-design/icons";
import type {
  Application,
  MetricsAppResponse,
  MetricsOverviewResponse,
  MetricsStageKey,
} from "@codecrush/contracts";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import dayjs from "dayjs";
import {
  downloadTraceCandidates,
  getApplicationMetrics,
  getApplications,
  getMetricsOverview,
} from "../../api/client";
import { MetricChart } from "../../components/MetricChart";

type RangePreset = "today" | "7d" | "custom";

const RATE_ALERT_THRESHOLD = 0.05;
const METRIC_COLORS = { blue: "#1677ff", green: "#16a34a", orange: "#f59e0b", red: "#ef4444", purple: "#7c3aed", cyan: "#0891b2" };
const STAGE_LABELS: Record<MetricsStageKey, string> = {
  rewrite: "问题改写",
  intent: "意图识别",
  embedding: "向量化",
  retrieval: "检索总段",
  rerank: "重排",
  generation: "回复生成",
};

function startOfToday(): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function dateInputValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function queryRange(preset: RangePreset, fromDate: string, toDate: string) {
  const to = new Date();
  if (preset === "today") return { from: startOfToday().toISOString(), to: to.toISOString() };
  if (preset === "7d") {
    const from = new Date(to);
    from.setDate(from.getDate() - 7);
    return { from: from.toISOString(), to: to.toISOString() };
  }
  const customFrom = new Date(`${fromDate}T00:00:00`);
  const customTo = new Date(`${toDate}T23:59:59.999`);
  return { from: customFrom.toISOString(), to: customTo.toISOString() };
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 1 : 2)}s` : `${Math.round(ms)}ms`;
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function SignalTitle({ label, help }: { label: string; help: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span>{label}</span>
      <Tooltip title={help} placement="top">
        <QuestionCircleOutlined
          aria-label={`${label}说明`}
          style={{ color: "#94a3b8", cursor: "help", fontSize: 13 }}
        />
      </Tooltip>
    </span>
  );
}

function halfChange(values: number[]): number | null {
  if (values.length < 2) return null;
  const cut = Math.ceil(values.length / 2);
  const before = values.slice(0, cut).reduce((sum, value) => sum + value, 0);
  const after = values.slice(cut).reduce((sum, value) => sum + value, 0);
  if (before === 0) return after === 0 ? 0 : null;
  return (after - before) / before;
}

function traceUrl(params: { from: string; to: string; agentId?: string; status?: string; quick?: string; stage?: MetricsStageKey; signal?: string; model?: string }): string {
  const query = new URLSearchParams({ from: params.from, to: params.to });
  if (params.agentId) query.set("agentId", params.agentId);
  if (params.status) query.set("status", params.status);
  if (params.quick) query.set("quick", params.quick);
  if (params.stage) query.set("stage", params.stage);
  if (params.signal) query.set("signal", params.signal);
  if (params.model) query.set("model", params.model);
  return `/admin/traces?${query.toString()}`;
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const [preset, setPreset] = useState<RangePreset>("7d");
  const [fromDate, setFromDate] = useState(dateInputValue(new Date(Date.now() - 7 * 86_400_000)));
  const [toDate, setToDate] = useState(dateInputValue(new Date()));
  const [applicationId, setApplicationId] = useState("");
  const [model, setModel] = useState("");
  const [applications, setApplications] = useState<Application[]>([]);
  const [data, setData] = useState<MetricsOverviewResponse | MetricsAppResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const range = useMemo(() => queryRange(preset, fromDate, toDate), [preset, fromDate, toDate]);

  useEffect(() => {
    let live = true;
    getApplications()
      .then((items) => {
        if (live) setApplications(items);
      })
      .catch(() => {
        if (live) message.warning("应用筛选项加载失败");
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (preset === "custom" && (!fromDate || !toDate || fromDate > toDate)) return;
    let live = true;
    setLoading(true);
    setError("");
    setData(null);
    const query = { ...range, model: model.trim() || undefined };
    const request = applicationId
      ? getApplicationMetrics(applicationId, query)
      : getMetricsOverview(query);
    request
      .then((response) => {
        if (live) setData(response);
      })
      .catch((reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : "运行指标加载失败");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [applicationId, fromDate, model, preset, range, toDate]);

  const window = data?.window;
  const trendOption = useMemo(() => {
    const series = data?.series ?? [];
    return {
      color: [METRIC_COLORS.blue, METRIC_COLORS.orange, METRIC_COLORS.red],
      tooltip: { trigger: "axis" },
      legend: { top: 0, right: 0, textStyle: { color: "#64748b" } },
      grid: { left: 40, right: 16, top: 38, bottom: 30 },
      xAxis: { type: "category", boundaryGap: false, data: series.map((item) => new Date(item.bucket).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })), axisLabel: { color: "#94a3b8", hideOverlap: true }, axisLine: { lineStyle: { color: "#e2e8f0" } } },
      yAxis: { type: "value", minInterval: 1, axisLabel: { color: "#94a3b8" }, splitLine: { lineStyle: { color: "#f1f5f9" } } },
      series: [
        { name: "问答量", type: "line", smooth: true, symbolSize: 7, areaStyle: { color: "rgba(22,119,255,.10)" }, data: series.map((item) => item.qaCount) },
        { name: "兜底", type: "bar", barMaxWidth: 14, data: series.map((item) => item.fallbackCount) },
        { name: "失败", type: "bar", barMaxWidth: 14, data: series.map((item) => item.failCount) },
      ],
    };
  }, [data?.series]);
  const applicationName = applications.find((item) => item.id === applicationId)?.name;
  const stages = applicationId && data && "stages" in data ? data.stages : [];
  const signals = applicationId && data && "signals" in data ? data.signals : null;
  const maxStageP95 = Math.max(1, ...stages.map((stage) => stage.p95Ms ?? 0));
  const stageOption = useMemo(() => ({
    color: [METRIC_COLORS.cyan, METRIC_COLORS.purple],
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (value: number) => formatDuration(value) },
    legend: { top: 0, right: 0, textStyle: { color: "#64748b" } },
    grid: { left: 68, right: 16, top: 36, bottom: 22 },
    xAxis: { type: "value", axisLabel: { formatter: (value: number) => formatDuration(value), color: "#94a3b8" }, splitLine: { lineStyle: { color: "#f1f5f9" } } },
    yAxis: { type: "category", data: stages.map((stage) => STAGE_LABELS[stage.stage]), axisLabel: { color: "#475569" }, axisLine: { show: false }, axisTick: { show: false } },
    series: [
      { name: "P50", type: "bar", barMaxWidth: 12, data: stages.map((stage) => stage.p50Ms ?? 0) },
      { name: "P95", type: "bar", barMaxWidth: 12, data: stages.map((stage) => stage.p95Ms ?? 0) },
    ],
  }), [stages]);
  const drill = (filters: { status?: string; quick?: string } = {}) =>
    navigate(traceUrl({ ...range, agentId: applicationId || undefined, ...filters }));
  const series = data?.series ?? [];
  const changes = {
    qa: halfChange(series.map((item) => item.qaCount)),
    fallback: halfChange(series.map((item) => item.fallbackCount)),
    fail: halfChange(series.map((item) => item.failCount)),
    tokens: halfChange(series.map((item) => item.inputTokens + item.outputTokens)),
  };

  const cards = [
    {
      label: "问答量",
      value: window?.qaCount.toLocaleString() ?? "—",
      sub: `输入 ${(window?.inputTokens ?? 0).toLocaleString()} / 输出 ${(window?.outputTokens ?? 0).toLocaleString()} tokens`,
      onClick: () => drill(),
      icon: <MessageOutlined />, color: METRIC_COLORS.blue,
      change: changes.qa,
    },
    {
      label: "兜底率",
      value: window ? formatRate(window.fallbackRate) : "—",
      sub: `${window?.fallbackCount ?? 0} 条兜底`,
      alert: (window?.fallbackRate ?? 0) > RATE_ALERT_THRESHOLD,
      onClick: () => drill({ status: "兜底" }),
      icon: <FallOutlined />, color: METRIC_COLORS.orange,
      change: changes.fallback,
    },
    {
      label: "失败率",
      value: window ? formatRate(window.failRate) : "—",
      sub: `${window?.failCount ?? 0} 条失败`,
      alert: (window?.failRate ?? 0) > RATE_ALERT_THRESHOLD,
      onClick: () => drill({ status: "失败" }),
      icon: <ThunderboltOutlined />, color: METRIC_COLORS.red,
      change: changes.fail,
    },
    {
      label: "端到端 P95",
      value: window ? formatDuration(window.p95Ms) : "—",
      sub: `P50 ${window ? formatDuration(window.p50Ms) : "—"}`,
      onClick: () => drill(),
      icon: <ClockCircleOutlined />, color: METRIC_COLORS.purple,
    },
    {
      label: "Token 消耗",
      value: ((window?.inputTokens ?? 0) + (window?.outputTokens ?? 0)).toLocaleString(),
      sub: `输入 ${(window?.inputTokens ?? 0).toLocaleString()} / 输出 ${(window?.outputTokens ?? 0).toLocaleString()}`,
      onClick: () => drill(),
      icon: <ApiOutlined />, color: METRIC_COLORS.cyan,
      change: changes.tokens,
    },
    {
      label: "花费（USD）",
      value: "—",
      sub: "真实计价尚未启用",
      tooltip: "costUsd 当前为预留字段且恒为 0；这里不把 0 展示成真实花费。",
      icon: <DollarOutlined />, color: "#94a3b8",
    },
  ];

  return (
    <div style={{ maxWidth: 1680, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 18, gap: 16, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#0f172a" }}>运行看板</div>
          <div style={{ marginTop: 5, fontSize: 13, color: "#64748b" }}>观察规模、质量与链路性能，并下钻到真实 Trace 样本</div>
        </div>
        <div style={{ fontSize: 12, color: "#94a3b8" }}>{applicationName ? `${applicationName} · ` : "全平台 · "}{model || "全部模型"}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18, flexWrap: "wrap", background: "#fff", padding: 14, border: "1px solid #e8edf3", borderRadius: 12, boxShadow: "0 4px 18px rgba(15,23,42,.04)" }}>
        <Space.Compact>
          <Button type={preset === "today" ? "primary" : "default"} onClick={() => setPreset("today")}>今日</Button>
          <Button type={preset === "7d" ? "primary" : "default"} onClick={() => setPreset("7d")}>近 7 日</Button>
          <Button type={preset === "custom" ? "primary" : "default"} onClick={() => setPreset("custom")}>自定义</Button>
        </Space.Compact>
        {preset === "custom" && (
          <>
            <DatePicker aria-label="开始日期" value={fromDate ? dayjs(fromDate) : null} format="YYYY-MM-DD" onChange={(value) => setFromDate(value ? value.format("YYYY-MM-DD") : "")} />
            <span style={{ color: "#94a3b8" }}>至</span>
            <DatePicker aria-label="结束日期" value={toDate ? dayjs(toDate) : null} format="YYYY-MM-DD" onChange={(value) => setToDate(value ? value.format("YYYY-MM-DD") : "")} />
          </>
        )}
        <Select
          aria-label="应用筛选"
          value={applicationId}
          onChange={setApplicationId}
          style={{ width: 180 }}
          options={[{ value: "", label: "全部应用" }, ...applications.map((item) => ({ value: item.id, label: item.name }))]}
        />
        <Input
          aria-label="模型筛选"
          allowClear
          value={model}
          onChange={(event) => setModel(event.target.value)}
          placeholder="模型名称（精确匹配）"
          style={{ width: 210 }}
        />
        <div style={{ flex: 1 }} />
        <Button onClick={() => { setPreset("7d"); setApplicationId(""); setModel(""); }}>重置筛选</Button>
      </div>

      {error && <Alert type="error" showIcon message="运行指标加载失败" description={error} style={{ marginBottom: 16 }} />}
      <Spin spinning={loading}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(205px,1fr))", gap: 14, marginBottom: 16 }}>
          {cards.map((card) => {
            const content = (
              <div
                key={card.label}
                role={card.onClick ? "button" : undefined}
                tabIndex={card.onClick ? 0 : undefined}
                onClick={card.onClick}
                onKeyDown={(event) => {
                  if (card.onClick && (event.key === "Enter" || event.key === " ")) card.onClick();
                }}
                style={{
                  background: "#fff",
                  border: `1px solid ${card.alert ? "#fecaca" : "#e8edf3"}`,
                  borderRadius: 12,
                  padding: "17px 18px",
                  cursor: card.onClick ? "pointer" : "default",
                  boxShadow: "0 4px 18px rgba(15,23,42,.04)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}><span style={{ fontSize: 13, color: "#64748b" }}>{card.label}</span><span style={{ width: 30, height: 30, display: "grid", placeItems: "center", borderRadius: 9, color: card.color, background: `${card.color}12`, fontSize: 16 }}>{card.icon}</span></div>
                <div style={{ fontSize: 26, fontWeight: 600, lineHeight: 1, marginBottom: 8, color: card.alert ? "#ff4d4f" : undefined }}>{card.value}</div>
                <div style={{ fontSize: 12, color: card.alert ? "#cf1322" : "rgba(0,0,0,.45)" }}>{card.sub}</div>
                {"change" in card && <div style={{ marginTop: 10, fontSize: 11, color: card.change == null ? "#94a3b8" : card.change > 0 ? METRIC_COLORS.orange : METRIC_COLORS.green }}>{card.change == null ? "前后半周期样本不足" : <>{card.change > 0 ? <RiseOutlined /> : <FallOutlined />} 前后半周期 {Math.abs(card.change * 100).toFixed(1)}%</>}</div>}
              </div>
            );
            return card.tooltip ? <Tooltip key={card.label} title={card.tooltip}>{content}</Tooltip> : content;
          })}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,2fr) minmax(260px,1fr)", gap: 16 }}>
          <div style={{ background: "#fff", border: "1px solid #e8edf3", borderRadius: 12, padding: "18px 20px", boxShadow: "0 4px 18px rgba(15,23,42,.04)" }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>问答量与异常趋势</div>
            <div style={{ color: "#94a3b8", fontSize: 12, marginBottom: 4 }}>对比每个时间桶的请求、兜底和失败数量</div>
            {series.length ? (
              <MetricChart ariaLabel="问答量趋势图" option={trendOption} height={250} />
            ) : (
              <div style={{ height: 190, display: "grid", placeItems: "center", color: "rgba(0,0,0,.35)" }}>所选时间范围暂无问答数据</div>
            )}
          </div>

          <div style={{ background: "#fff", border: "1px solid #f0f0f0", borderRadius: 8, padding: "16px 20px" }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>质量与可靠性</div>
            {[
              ["低分召回", window?.lowRecallCount ?? 0, "low_recall"],
              ["无引用", window?.noCiteCount ?? 0, "no_citations"],
              ["拒答", window?.refusalCount ?? 0, "refusal"],
              ["超时", window?.timeoutCount ?? 0, "timeout"],
            ].map(([label, count, signal]) => (
              <div key={String(label)} role="button" tabIndex={0} aria-label={`查看${String(label)} Trace样本`} onClick={() => navigate(traceUrl({ ...range, agentId: applicationId || undefined, model: model || undefined, signal: String(signal) }))} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") navigate(traceUrl({ ...range, agentId: applicationId || undefined, model: model || undefined, signal: String(signal) })); }} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 8px", margin: "0 -8px", borderBottom: "1px solid #f5f5f5", cursor: "pointer", borderRadius: 6 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 9, color: "#334155" }}><span style={{ width: 8, height: 8, borderRadius: "50%", background: signal === "low_recall" ? METRIC_COLORS.orange : signal === "no_citations" ? METRIC_COLORS.cyan : signal === "refusal" ? METRIC_COLORS.red : METRIC_COLORS.purple }} />{label}</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 10, color: "#475569", fontWeight: 600 }}>
                  {Number(count).toLocaleString()} · {formatRate((Number(count) / Math.max(1, window?.qaCount ?? 0)))} <span style={{ color: "#94a3b8", fontSize: 16 }}>›</span>
                </span>
              </div>
            ))}
            <div style={{ fontSize: 11, color: "rgba(0,0,0,.35)", marginTop: 12 }}>点击指标可进入同时间范围的 Trace 样本。</div>
          </div>
        </div>

        {applicationId && stages.length > 0 && (
          <div style={{ background: "#fff", border: "1px solid #f0f0f0", borderRadius: 8, padding: "16px 20px", marginTop: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "baseline", marginBottom: 6, flexWrap: "wrap" }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{applicationName ?? "当前应用"} · 分阶段耗时</div>
              <div style={{ fontSize: 11, color: "rgba(0,0,0,.35)" }}>按 span 样本统计；检索总段包含向量化/重排，阶段不可相加</div>
            </div>
            <MetricChart ariaLabel="各阶段 P50 与 P95 耗时对比图" option={stageOption} height={250} />
            <div style={{ display: "grid", gridTemplateColumns: "120px 80px 90px 90px minmax(120px,1fr)", padding: "9px 10px", background: "#fafafa", color: "rgba(0,0,0,.45)", fontSize: 12 }}>
              <span>阶段</span><span>样本数</span><span>P50</span><span>P95</span><span>P95 相对耗时</span>
            </div>
            {stages.map((stage) => {
              const clickable = stage.sampleCount > 0;
              const openCandidates = () => {
                if (clickable) navigate(traceUrl({ ...range, agentId: applicationId, stage: stage.stage }));
              };
              return (
                <div
                  key={stage.stage}
                  role={clickable ? "button" : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onClick={openCandidates}
                  onKeyDown={(event) => {
                    if (clickable && (event.key === "Enter" || event.key === " ")) openCandidates();
                  }}
                  style={{ display: "grid", gridTemplateColumns: "120px 80px 90px 90px minmax(120px,1fr)", alignItems: "center", padding: "11px 10px", borderBottom: "1px solid #f5f5f5", fontSize: 13, cursor: clickable ? "pointer" : "default" }}
                  aria-label={clickable ? `${STAGE_LABELS[stage.stage]}，查看该应用同期 Trace` : undefined}
                >
                  <span style={{ fontWeight: 500 }}>{STAGE_LABELS[stage.stage]}</span>
                  <span style={{ color: "rgba(0,0,0,.45)" }}>{stage.sampleCount} 次</span>
                  <span>{stage.p50Ms == null ? "—" : formatDuration(stage.p50Ms)}</span>
                  <span style={{ fontWeight: 600 }}>{stage.p95Ms == null ? "—" : formatDuration(stage.p95Ms)}</span>
                  <span style={{ height: 8, borderRadius: 4, background: "#f5f5f5", overflow: "hidden" }}>
                    <span style={{ display: "block", width: `${((stage.p95Ms ?? 0) / maxStageP95) * 100}%`, height: "100%", background: stage.sampleCount > 0 ? "#69b1ff" : "transparent", borderRadius: 4 }} />
                  </span>
                </div>
              );
            })}
            <div style={{ marginTop: 10, fontSize: 11, color: "rgba(0,0,0,.35)" }}>
              点击有样本的阶段可精确查看包含该阶段的同期 Trace{model ? "；Trace 列表暂不保留模型筛选" : ""}。
            </div>
          </div>
        )}

        {applicationId && signals && (
          <div style={{ background: "#fff", border: "1px solid #e8edf3", borderRadius: 12, padding: "20px", marginTop: 16, boxShadow: "0 4px 18px rgba(15,23,42,.04)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 600, color: "#0f172a" }}>运行信号与质量分布</div>
                <div style={{ marginTop: 4, color: "#94a3b8", fontSize: 12 }}>生成、检索与引用链路的关键运行信号</div>
              </div>
              <Button
                size="small"
                icon={<DownloadOutlined />}
                onClick={() => downloadTraceCandidates({ agentId: applicationId, model: model || undefined, from: range.from, to: range.to, page: 1, pageSize: 50 })
                  .catch((error: unknown) => message.error(error instanceof Error ? error.message : "导出失败"))}
              >导出候选样本</Button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(205px,1fr))", gap: 12 }}>
              {[
                { label: "首字延迟 P95", value: signals.ttft.p95Ms == null ? "—" : formatDuration(signals.ttft.p95Ms), sub: `${signals.ttft.sampleCount} 个有效样本`, signal: "", color: METRIC_COLORS.purple, help: "95% 的有效生成请求会在该时间内开始输出首个 token；仅统计记录到首 token 的请求。" },
                { label: "生成速度 P50", value: signals.generationRate.p50TokensPerSecond == null ? "—" : `${signals.generationRate.p50TokensPerSecond.toFixed(1)} token/s`, sub: `${signals.generationRate.sampleCount} 个有效样本`, signal: "", color: METRIC_COLORS.blue, help: "首 token 输出后的生成速度中位数，不包含等待首 token 的时间；数值越高表示持续输出越快。" },
                { label: "结构化修复率", value: signals.repair.rate == null ? "—" : formatRate(signals.repair.rate), sub: `${signals.repair.attemptCount} 次修复 / ${signals.repair.eligibleCount} 次节点调用`, signal: "repair", color: METRIC_COLORS.orange, help: "rewrite 或 intent 首次结构化校验失败并触发修复重试的比例；分母为具备结构化输出契约的节点调用。" },
                { label: "关键词召回降级率", value: signals.degradation.keyword.rate == null ? "—" : formatRate(signals.degradation.keyword.rate), sub: `${signals.degradation.keyword.count} 次降级 / ${signals.degradation.keyword.eligibleCount} 次检索`, signal: "keyword_degraded", color: METRIC_COLORS.orange, help: "关键词召回通道失败并退化为纯向量检索的比例；0/0 表示所选范围没有启用关键词召回的样本。" },
                { label: "重排降级率", value: signals.degradation.rerank.rate == null ? "—" : formatRate(signals.degradation.rerank.rate), sub: `${signals.degradation.rerank.count} 次降级 / ${signals.degradation.rerank.eligibleCount} 次请求`, signal: "rerank_degraded", color: METRIC_COLORS.orange, help: "请求了 Rerank 但重排失败，系统保留融合结果继续回答的比例；分母为实际请求重排的检索。" },
                { label: "回答可信度 P50", value: signals.confidence.p50 == null ? "—" : signals.confidence.p50.toFixed(2), sub: `${signals.confidence.sampleCount} 个有效样本`, signal: "", color: METRIC_COLORS.green, help: "由检索命中分数和引用情况计算的启发式可信度中位数，不等同于模型概率，也不代表事实正确率。" },
                { label: "平均引用条数", value: signals.citations.averageCount == null ? "—" : signals.citations.averageCount.toFixed(1), sub: `${signals.citations.sampleCount} 个有引用信号的回答`, signal: "", color: METRIC_COLORS.cyan, help: "记录到引用信号的回答平均携带的引用条数；历史未埋点数据不计入分母。" },
              ].map(({ label, value, sub, signal, color, help }) => (
                <div role={signal ? "button" : undefined} tabIndex={signal ? 0 : undefined} onClick={signal ? () => navigate(traceUrl({ ...range, agentId: applicationId, model: model || undefined, signal })) : undefined} key={label} style={{ position: "relative", overflow: "hidden", border: "1px solid #e8edf3", borderRadius: 10, padding: "15px 16px", cursor: signal ? "pointer" : "default", background: "#fff" }}>
                  <span style={{ position: "absolute", inset: "0 auto 0 0", width: 3, background: color }} />
                  <div style={{ color: "#64748b", fontSize: 12 }}><SignalTitle label={label} help={help} /></div>
                  <div style={{ fontSize: 23, fontWeight: 650, margin: "8px 0 7px", color: "#0f172a" }}>{value}</div>
                  <div style={{ color: "#94a3b8", fontSize: 11 }}>{sub}</div>
                </div>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(360px,1fr))", gap: 16, marginTop: 16 }}>
              <div style={{ border: "1px solid #e8edf3", borderRadius: 10, padding: 16 }}>
                <div style={{ fontWeight: 600, color: "#0f172a" }}><SignalTitle label="回答可信度分布" help="将启发式可信度按区间分组。点击任一区间可查看对应的 Trace 样本。" /></div>
                {signals.confidence.buckets.map((b, index) => {
                  const labels: Record<string, string> = { very_low: "很低（< 0.4）", low: "偏低（0.4–0.7）", medium: "中等（0.7–0.9）", high: "高（≥ 0.9）" };
                  const colors = [METRIC_COLORS.red, METRIC_COLORS.orange, METRIC_COLORS.blue, METRIC_COLORS.green];
                  const total = Math.max(1, signals.confidence.buckets.reduce((sum, item) => sum + item.count, 0));
                  const percent = (b.count / total) * 100;
                  return <div role="button" tabIndex={0} onClick={() => navigate(traceUrl({ ...range, agentId: applicationId, model: model || undefined, signal: `confidence_${b.key}` }))} key={b.key} style={{ marginTop: 13, cursor: "pointer" }}><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12 }}><span style={{ color: "#475569" }}>{labels[b.key] ?? b.key}</span><span style={{ color: "#64748b" }}><b style={{ color: "#0f172a" }}>{b.count}</b> · {percent.toFixed(0)}%</span></div><div style={{ height: 7, borderRadius: 6, background: "#f1f5f9", overflow: "hidden" }}><span style={{ display: "block", height: "100%", width: `${percent}%`, borderRadius: 6, background: colors[index] ?? METRIC_COLORS.blue }} /></div></div>;
                })}
              </div>
              <div style={{ border: "1px solid #e8edf3", borderRadius: 10, padding: 16 }}>
                <div style={{ fontWeight: 600, color: "#0f172a" }}><SignalTitle label="引用数量与内容覆盖" help="引用数量表示每个回答携带的引用条数；内容覆盖表示回答中的关键内容是否被引用来源完整支持。" /></div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, marginTop: 13 }}>
                  {signals.citations.countBuckets.map((b) => {
                    const labels: Record<string, string> = { none: "无引用", one: "1 条", two_three: "2–3 条", four_plus: "4 条以上" };
                    return <div role="button" tabIndex={0} onClick={() => navigate(traceUrl({ ...range, agentId: applicationId, model: model || undefined, signal: `citations_${b.key}` }))} key={b.key} style={{ padding: "10px 8px", borderRadius: 8, background: "#f8fafc", textAlign: "center", cursor: "pointer" }}><div style={{ fontSize: 19, fontWeight: 650, color: "#0f172a" }}>{b.count}</div><div style={{ marginTop: 3, color: "#64748b", fontSize: 11 }}>{labels[b.key] ?? b.key}</div></div>;
                  })}
                </div>
                <div style={{ marginTop: 15, paddingTop: 13, borderTop: "1px solid #eef2f7" }}>
                  <div style={{ marginBottom: 9, color: "#64748b", fontSize: 12 }}>内容覆盖情况</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
                    {[{ label: "完整覆盖", count: signals.citations.coverage.full, signal: "coverage_full", color: METRIC_COLORS.green }, { label: "部分覆盖", count: signals.citations.coverage.partial, signal: "coverage_partial", color: METRIC_COLORS.orange }, { label: "覆盖未知", count: signals.citations.coverage.unknown, signal: "", color: "#94a3b8" }].map((item) => <div key={item.label} role={item.signal ? "button" : undefined} tabIndex={item.signal ? 0 : undefined} onClick={item.signal ? () => navigate(traceUrl({ ...range, agentId: applicationId, model: model || undefined, signal: item.signal })) : undefined} style={{ borderLeft: `3px solid ${item.color}`, padding: "5px 8px", cursor: item.signal ? "pointer" : "default" }}><div style={{ fontSize: 17, fontWeight: 650, color: "#0f172a" }}>{item.count}</div><div style={{ color: "#64748b", fontSize: 11 }}>{item.label}</div></div>)}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </Spin>
    </div>
  );
}
