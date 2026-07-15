import { useEffect, useMemo, useState } from "react";
import { Button, Drawer, InputNumber, message, Spin, Switch } from "antd";
import type {
  OnlineEvalSettingsResponse,
  QualityMetric,
  QualityOverviewResponse,
  UpdateOnlineEvalSettingsRequest,
} from "@codecrush/contracts";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  getOnlineEvalSettings,
  getQualityOverview,
  updateOnlineEvalSettings,
} from "../../api/client";
import { buildMetricTraceLink, toOverviewQuery, type QualityRange } from "./qualityViewModel";

const RANGES: Array<{ value: QualityRange; label: string }> = [
  { value: "today", label: "今日" },
  { value: "7d", label: "近 7 日" },
  { value: "30d", label: "近 30 日" },
];
const METRICS: Array<{ key: QualityMetric; label: string }> = [
  { key: "faithfulness", label: "事实一致性" },
  { key: "answerRelevancy", label: "答案相关性" },
  { key: "contextPrecision", label: "上下文精度" },
];
const STATUS_LABEL: Record<QualityOverviewResponse["meta"]["status"], string> = {
  disabled: "在线评测未开启",
  healthy: "在线 LLM 裁判",
  lagging: "评测滞后",
  budget_reduced: "预算降采样",
  model_unavailable: "评测模型不可用",
};

export default function QualityPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawRange = searchParams.get("range");
  const range: QualityRange = rawRange === "today" || rawRange === "30d" ? rawRange : "7d";
  const agentId = searchParams.get("agentId") ?? "";
  const [overview, setOverview] = useState<QualityOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [activeQuery, setActiveQuery] = useState(() => toOverviewQuery(range));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsData, setSettingsData] = useState<OnlineEvalSettingsResponse | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [draft, setDraft] = useState<UpdateOnlineEvalSettingsRequest>({});
  const [thresholdError, setThresholdError] = useState(false);

  useEffect(() => {
    let live = true;
    const query = { ...toOverviewQuery(range), agentId: agentId || undefined };
    setActiveQuery(query);
    setLoading(true);
    getQualityOverview(query)
      .then((result) => {
        if (live) setOverview(result);
      })
      .catch((error: unknown) => {
        if (live) message.error(error instanceof Error ? error.message : "答案质量加载失败");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [range, agentId, reloadKey]);

  const agents = useMemo(() => {
    const rows = overview?.byAgent ?? [];
    if (agentId && !rows.some((row) => row.agentId === agentId)) {
      return [{ agentId, agentName: agentId, scores: null, sampleCount: 0 }, ...rows];
    }
    return rows;
  }, [overview, agentId]);

  const updateUrl = (key: string, value?: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next);
  };

  const openSettings = async () => {
    setSettingsOpen(true);
    if (settingsData) return;
    setSettingsLoading(true);
    try {
      const result = await getOnlineEvalSettings();
      setSettingsData(result);
      setDraft(result.settings);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "设置加载失败");
    } finally {
      setSettingsLoading(false);
    }
  };

  const saveSettings = async () => {
    const values = [
      draft.faithfulnessThreshold,
      draft.answerRelevancyThreshold,
      draft.contextPrecisionThreshold,
    ];
    if (
      values.some(
        (value) => value !== undefined && (!Number.isInteger(value) || value < 0 || value > 100),
      )
    ) {
      setThresholdError(true);
      return;
    }
    setThresholdError(false);
    try {
      const saved = await updateOnlineEvalSettings(draft);
      setSettingsData(saved);
      setDraft(saved.settings);
      setSettingsOpen(false);
      message.success("在线评测设置已保存");
      setReloadKey((value) => value + 1);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "设置保存失败");
    }
  };

  if (loading && !overview) {
    return (
      <div style={{ padding: 64, textAlign: "center" }}>
        <Spin />
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>答案质量</div>
          <div style={{ color: "rgba(0,0,0,.45)", fontSize: 12 }}>
            持续观测线上回答，并把低质量样本送回优化闭环
          </div>
        </div>
        <div style={{ flex: 1 }} />
        {RANGES.map((item) => (
          <Button
            key={item.value}
            type={range === item.value ? "primary" : "default"}
            onClick={() => updateUrl("range", item.value)}
          >
            {item.label}
          </Button>
        ))}
        <select
          aria-label="应用"
          value={agentId}
          onChange={(event) => updateUrl("agentId", event.target.value || undefined)}
          style={{ height: 32, minWidth: 140 }}
        >
          <option value="">全部应用</option>
          {agents.map((agent) => (
            <option key={agent.agentId} value={agent.agentId}>
              {agent.agentName}
            </option>
          ))}
        </select>
        <Button aria-label="设置" onClick={openSettings}>
          设置
        </Button>
      </div>

      {overview && (
        <>
          <div
            style={{
              padding: 14,
              borderRadius: 8,
              marginBottom: 16,
              background: overview.meta.status === "healthy" ? "#f6ffed" : "#fffbe6",
              border: "1px solid #d9d9d9",
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <strong>{STATUS_LABEL[overview.meta.status]}</strong>
            <span style={{ color: "rgba(0,0,0,.55)" }}>
              已评测 {overview.meta.evaluatedCount} / 可评测 {overview.meta.eligibleCount} · 待处理{" "}
              {overview.meta.backlog}
            </span>
            <div style={{ flex: 1 }} />
            {overview.meta.status === "disabled" && <Button onClick={openSettings}>去设置</Button>}
          </div>

          {overview.meta.evaluatedCount === 0 ? (
            <div
              style={{
                padding: 64,
                textAlign: "center",
                background: "#fff",
                borderRadius: 8,
                color: "rgba(0,0,0,.4)",
              }}
            >
              暂无评测样本
            </div>
          ) : (
            <>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, 1fr)",
                  gap: 12,
                  marginBottom: 16,
                }}
              >
                {METRICS.map(({ key, label }) => {
                  const metric = overview.metrics[key];
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-label={`${label} ${metric.value ?? "暂无"}`}
                      onClick={() =>
                        navigate(buildMetricTraceLink(key, metric.threshold, activeQuery.from!))
                      }
                      style={{
                        textAlign: "left",
                        padding: 18,
                        background: "#fff",
                        border: `1px solid ${metric.low ? "#ffccc7" : "#f0f0f0"}`,
                        borderRadius: 8,
                        cursor: "pointer",
                      }}
                    >
                      <div style={{ color: "rgba(0,0,0,.45)", fontSize: 12 }}>{label}</div>
                      <div
                        style={{
                          fontSize: 30,
                          fontWeight: 700,
                          color: metric.low ? "#cf1322" : "#1677ff",
                        }}
                      >
                        {metric.value ?? "—"}
                      </div>
                      {metric.sampleCount < 20 ? (
                        <div style={{ color: "#d48806" }}>样本不足</div>
                      ) : metric.previousDelta !== null ? (
                        <div>
                          {metric.previousDelta >= 0 ? "▲" : "▼"} {Math.abs(metric.previousDelta)}
                        </div>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              <div
                style={{
                  background: "#fff",
                  border: "1px solid #f0f0f0",
                  borderRadius: 8,
                  padding: 16,
                  marginBottom: 16,
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 12 }}>质量趋势</div>
                <div style={{ display: "flex", alignItems: "flex-end", gap: 6, minHeight: 120 }}>
                  {overview.trend.map((point) => (
                    <div
                      key={point.bucket}
                      data-testid={
                        point.insufficientSample ? "trend-point-insufficient" : "trend-point"
                      }
                      title={`${point.bucket} · n=${point.sampleCount}`}
                      style={{
                        flex: 1,
                        minWidth: 8,
                        height: `${Math.max(8, point.faithfulness ?? 0)}%`,
                        background: "#1677ff",
                        opacity: point.insufficientSample ? 0.35 : 1,
                      }}
                    />
                  ))}
                  {overview.trend.length === 0 && (
                    <span style={{ color: "rgba(0,0,0,.35)" }}>暂无趋势数据</span>
                  )}
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div
                  style={{
                    background: "#fff",
                    border: "1px solid #f0f0f0",
                    borderRadius: 8,
                    padding: 16,
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 12 }}>分应用质量</div>
                  {overview.byAgent.map((agent) => (
                    <div
                      key={agent.agentId}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        padding: "8px 0",
                        borderBottom: "1px solid #f5f5f5",
                      }}
                    >
                      <span>{agent.agentName}</span>
                      <span>
                        {agent.scores ? Math.min(...Object.values(agent.scores)) : "—"} · n=
                        {agent.sampleCount}
                      </span>
                    </div>
                  ))}
                </div>
                <div
                  style={{
                    background: "#fff",
                    border: "1px solid #f0f0f0",
                    borderRadius: 8,
                    padding: 16,
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 12 }}>低质量样本</div>
                  {overview.lowSamples.map((sample) => (
                    <button
                      key={sample.targetTraceId}
                      type="button"
                      onClick={() =>
                        navigate(`/admin/traces/${sample.targetTraceId}?panel=quality`)
                      }
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: 10,
                        border: 0,
                        borderBottom: "1px solid #f5f5f5",
                        background: "transparent",
                        cursor: "pointer",
                      }}
                    >
                      <strong>{sample.question}</strong>
                      <div style={{ color: "#cf1322" }}>
                        {sample.minMetric} · {sample.minScore}
                      </div>
                      <div style={{ color: "rgba(0,0,0,.45)" }}>{sample.evidenceSummary}</div>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </>
      )}

      <Drawer
        title="在线评测设置"
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        width={480}
      >
        {settingsLoading || !settingsData ? (
          <Spin />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <label>
              开启在线评测{" "}
              <Switch
                checked={draft.enabled ?? settingsData.settings.enabled}
                onChange={(enabled) => setDraft((value) => ({ ...value, enabled }))}
              />
            </label>
            <label>
              抽样率{" "}
              <InputNumber
                min={0}
                max={1}
                step={0.05}
                value={draft.sampleRate ?? settingsData.settings.sampleRate}
                onChange={(value) => setDraft((state) => ({ ...state, sampleRate: value ?? 0 }))}
              />
            </label>
            <label>
              Judge 模型{" "}
              <select
                value={draft.judgeModelId ?? ""}
                onChange={(event) =>
                  setDraft((value) => ({ ...value, judgeModelId: event.target.value || null }))
                }
              >
                {settingsData.models.judges.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                    {model.available ? "" : "（不可用）"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Embedding 模型{" "}
              <select
                value={draft.embeddingModelId ?? ""}
                onChange={(event) =>
                  setDraft((value) => ({ ...value, embeddingModelId: event.target.value || null }))
                }
              >
                {settingsData.models.embeddings.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                    {model.available ? "" : "（不可用）"}
                  </option>
                ))}
              </select>
            </label>
            <ThresholdInput
              label="事实一致性阈值"
              value={draft.faithfulnessThreshold ?? settingsData.settings.faithfulnessThreshold}
              onChange={(faithfulnessThreshold) =>
                setDraft((value) => ({ ...value, faithfulnessThreshold }))
              }
            />
            <ThresholdInput
              label="答案相关性阈值"
              value={
                draft.answerRelevancyThreshold ?? settingsData.settings.answerRelevancyThreshold
              }
              onChange={(answerRelevancyThreshold) =>
                setDraft((value) => ({ ...value, answerRelevancyThreshold }))
              }
            />
            <ThresholdInput
              label="上下文精度阈值"
              value={
                draft.contextPrecisionThreshold ?? settingsData.settings.contextPrecisionThreshold
              }
              onChange={(contextPrecisionThreshold) =>
                setDraft((value) => ({ ...value, contextPrecisionThreshold }))
              }
            />
            {thresholdError && <div style={{ color: "#cf1322" }}>请输入 0–100 的整数</div>}
            <label>
              每日上限{" "}
              <InputNumber
                min={1}
                max={10_000}
                value={draft.dailyCap ?? settingsData.settings.dailyCap}
                onChange={(value) => setDraft((state) => ({ ...state, dailyCap: value ?? 1 }))}
              />
            </label>
            <Button type="primary" onClick={saveSettings}>
              保存
            </Button>
          </div>
        )}
      </Drawer>
    </div>
  );
}

function ThresholdInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      {label}
      <input
        aria-label={label}
        type="number"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
