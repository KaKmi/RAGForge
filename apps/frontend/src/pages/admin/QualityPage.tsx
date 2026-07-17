import { Fragment, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Divider,
  Drawer,
  Empty,
  Flex,
  Form,
  InputNumber,
  Select,
  Space,
  Spin,
  Statistic,
  Switch,
  Tooltip,
  Typography,
  message,
} from "antd";
import type { EChartsCoreOption } from "echarts/core";
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
import { MetricChart } from "../../components/MetricChart";
import { buildMetricTraceLink, toOverviewQuery, type QualityRange } from "./qualityViewModel";

type TrendTooltipParam = {
  axisValue?: string;
  dataIndex?: number;
  marker?: string;
  seriesName?: string;
  value?: number | null;
};

const { Title, Text } = Typography;

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
  worker_stalled: "评测 worker 未在运行",
};
// 「没在跑」不是「落后」——worker 是独立进程（PROCESS_ROLE=worker），没起来时这里是唯一的信号。
const STATUS_HINT: Partial<Record<QualityOverviewResponse["meta"]["status"], string>> = {
  worker_stalled: "worker 超过 35 分钟没有报到。评测已停，新问答不会被评分。",
  lagging: "worker 在跑，但候选还没消化完。",
};
// Alert 语义色：healthy=success，disabled=info，其余（滞后/降采样/不可用/未运行）=warning——保留历史分数不报错
const STATUS_ALERT: Record<
  QualityOverviewResponse["meta"]["status"],
  "success" | "info" | "warning"
> = {
  disabled: "info",
  healthy: "success",
  lagging: "warning",
  budget_reduced: "warning",
  model_unavailable: "warning",
  worker_stalled: "warning",
};
const TREND_SERIES = [
  { key: "faithfulness", label: "事实一致性", color: "#1677ff" },
  { key: "answerRelevancy", label: "答案相关性", color: "#722ed1" },
  { key: "contextPrecision", label: "上下文精度", color: "#13a8a8" },
] as const;

function TrendChart({ points }: { points: QualityOverviewResponse["trend"] }) {
  const option = useMemo<EChartsCoreOption>(() => {
    const counts = points.map((point) => point.sampleCount);
    return {
      color: TREND_SERIES.map((series) => series.color),
      tooltip: {
        trigger: "axis",
        formatter: (params: TrendTooltipParam[]) => {
          const index = params[0]?.dataIndex ?? 0;
          const sampleCount = counts[index] ?? 0;
          const lines = params
            .map((param) => `${param.marker}${param.seriesName}：${param.value ?? "—"}`)
            .join("<br/>");
          const note = sampleCount < 10 ? "（样本不足）" : "";
          return `${params[0]?.axisValue ?? ""}<br/>${lines}<br/>样本数 ${sampleCount}${note}`;
        },
      },
      legend: { top: 0, right: 0, textStyle: { color: "#64748b" } },
      grid: { left: 36, right: 16, top: 38, bottom: 28 },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: points.map((point) =>
          new Date(point.bucket).toLocaleString([], {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          }),
        ),
        axisLabel: { color: "#94a3b8", hideOverlap: true },
        axisLine: { lineStyle: { color: "#e2e8f0" } },
      },
      yAxis: {
        type: "value",
        min: 0,
        max: 100,
        axisLabel: { color: "#94a3b8" },
        splitLine: { lineStyle: { color: "#f1f5f9" } },
      },
      series: TREND_SERIES.map((series) => ({
        name: series.label,
        type: "line",
        smooth: true,
        symbolSize: 7,
        connectNulls: true,
        data: points.map((point) => point[series.key]),
      })),
    };
  }, [points]);

  if (points.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无趋势数据" />;
  }
  return <MetricChart ariaLabel="三项质量指标趋势" option={option} height={240} />;
}

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
  const [modelError, setModelError] = useState<string | null>(null);

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

  // 窗口内既没评过、水位线又已越过的 trace —— 永久错过。三个计数同窗口同过滤，故可直接相减。
  const missedCount = overview
    ? Math.max(
        0,
        overview.meta.eligibleCount - overview.meta.evaluatedCount - overview.meta.evaluableCount,
      )
    : 0;

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
    const enabled = draft.enabled ?? settingsData?.settings.enabled ?? false;
    const judgeModelId =
      draft.judgeModelId !== undefined
        ? draft.judgeModelId
        : (settingsData?.settings.judgeModelId ?? null);
    const embeddingModelId =
      draft.embeddingModelId !== undefined
        ? draft.embeddingModelId
        : (settingsData?.settings.embeddingModelId ?? null);
    const judgeAvailable = settingsData?.models.judges.some(
      (model) => model.id === judgeModelId && model.available,
    );
    const embeddingAvailable = settingsData?.models.embeddings.some(
      (model) => model.id === embeddingModelId && model.available,
    );
    if (enabled && (!judgeModelId || !embeddingModelId || !judgeAvailable || !embeddingAvailable)) {
      setModelError("开启在线评测前，请选择可用的 Judge 与 Embedding 模型");
      return;
    }
    setModelError(null);
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
      <Flex justify="center" style={{ padding: 64 }}>
        <Spin />
      </Flex>
    );
  }

  return (
    <div>
      <Flex align="center" gap={12} wrap style={{ marginBottom: 16 }}>
        <div style={{ marginRight: "auto" }}>
          <Title level={4} style={{ margin: 0 }}>
            答案质量
          </Title>
          <Text type="secondary" style={{ fontSize: 12 }}>
            持续观测线上回答，并把低质量样本送回优化闭环
          </Text>
        </div>
        <Space wrap>
          <Space.Compact>
            {RANGES.map((item) => (
              <Button
                key={item.value}
                type={range === item.value ? "primary" : "default"}
                onClick={() => updateUrl("range", item.value)}
              >
                {item.label}
              </Button>
            ))}
          </Space.Compact>
          <Select
            data-testid="agent-filter"
            aria-label="应用"
            style={{ minWidth: 160 }}
            value={agentId || undefined}
            placeholder="全部应用"
            allowClear
            onChange={(value?: string) => updateUrl("agentId", value || undefined)}
            options={agents.map((agent) => ({ value: agent.agentId, label: agent.agentName }))}
          />
          <Button aria-label="设置" onClick={openSettings}>
            设置
          </Button>
        </Space>
      </Flex>

      {overview && (
        <>
          <Alert
            type={STATUS_ALERT[overview.meta.status]}
            showIcon
            style={{ marginBottom: 16 }}
            description={STATUS_HINT[overview.meta.status]}
            title={
              <Space size={12} wrap>
                <strong>{STATUS_LABEL[overview.meta.status]}</strong>
                <Text type="secondary">
                  已评测 {overview.meta.evaluatedCount} / 窗口内 {overview.meta.eligibleCount}
                </Text>
                {missedCount > 0 && (
                  <Tooltip title="水位线已越过这些 trace，它们不会再被评测；调高抽样率也不会回补。">
                    <Text type="secondary" style={{ borderBottom: "1px dotted", cursor: "help" }}>
                      已错过 {missedCount}
                    </Text>
                  </Tooltip>
                )}
                <Text type="secondary">待处理 {overview.meta.backlog}</Text>
              </Space>
            }
            action={
              overview.meta.status === "disabled" ? (
                <Button size="small" onClick={openSettings}>
                  去设置
                </Button>
              ) : undefined
            }
          />

          {overview.meta.evaluatedCount === 0 ? (
            <Card>
              <Empty description="暂无评测样本" />
            </Card>
          ) : (
            <>
              <Flex gap={12} wrap style={{ marginBottom: 16 }}>
                {METRICS.map(({ key, label }) => {
                  const metric = overview.metrics[key];
                  return (
                    <Card
                      key={key}
                      hoverable
                      role="button"
                      data-testid={`metric-${key}`}
                      aria-label={`${label} ${metric.value ?? "暂无"}`}
                      onClick={() =>
                        navigate(buildMetricTraceLink(key, metric.threshold, activeQuery.from!))
                      }
                      style={{ flex: "1 1 200px", borderColor: metric.low ? "#ffccc7" : undefined }}
                      styles={{ body: { padding: 18 } }}
                    >
                      <Statistic
                        title={label}
                        value={metric.value ?? "—"}
                        styles={{ content: { color: metric.low ? "#cf1322" : "#1677ff" } }}
                      />
                      {metric.sampleCount < 20 ? (
                        <Text style={{ color: "#d48806" }}>样本不足</Text>
                      ) : metric.previousDelta !== null ? (
                        <Text type={metric.previousDelta >= 0 ? "success" : "danger"}>
                          {metric.previousDelta >= 0 ? "▲" : "▼"} {Math.abs(metric.previousDelta)}
                        </Text>
                      ) : null}
                    </Card>
                  );
                })}
              </Flex>

              <Card title="质量趋势" style={{ marginBottom: 16 }}>
                <TrendChart points={overview.trend} />
              </Card>

              <Flex gap={12} align="stretch" wrap>
                <Card title="分应用质量" style={{ flex: "1 1 320px" }}>
                  {overview.byAgent.length === 0 ? (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
                  ) : (
                    overview.byAgent.map((agent, index) => (
                      <Fragment key={agent.agentId}>
                        {index > 0 && <Divider style={{ margin: "8px 0" }} />}
                        <Flex justify="space-between" gap={12}>
                          <Text>{agent.agentName}</Text>
                          <Text>
                            {agent.scores ? Math.min(...Object.values(agent.scores)) : "—"} · n=
                            {agent.sampleCount}
                          </Text>
                        </Flex>
                      </Fragment>
                    ))
                  )}
                </Card>
                <Card title="低质量样本" style={{ flex: "1 1 320px" }}>
                  {overview.lowSamples.length === 0 ? (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
                  ) : (
                    overview.lowSamples.map((sample, index) => {
                      const open = () =>
                        navigate(`/admin/traces/${sample.targetTraceId}?panel=quality`);
                      return (
                        <Fragment key={sample.targetTraceId}>
                          {index > 0 && <Divider style={{ margin: "8px 0" }} />}
                          <Flex
                            vertical
                            gap={2}
                            role="button"
                            tabIndex={0}
                            onClick={open}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") open();
                            }}
                            style={{ cursor: "pointer", padding: "4px 0" }}
                          >
                            <Text strong>{sample.question}</Text>
                            <Text type="danger">
                              {sample.minMetric} · {sample.minScore}
                            </Text>
                            <Text type="secondary">{sample.evidenceSummary}</Text>
                          </Flex>
                        </Fragment>
                      );
                    })
                  )}
                </Card>
              </Flex>
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
          <Form layout="vertical">
            <Form.Item label="开启在线评测">
              <Switch
                checked={draft.enabled ?? settingsData.settings.enabled}
                onChange={(enabled) => setDraft((value) => ({ ...value, enabled }))}
              />
            </Form.Item>
            <Form.Item label="抽样率">
              <InputNumber
                min={0}
                max={1}
                step={0.05}
                style={{ width: "100%" }}
                value={draft.sampleRate ?? settingsData.settings.sampleRate}
                onChange={(value) => setDraft((state) => ({ ...state, sampleRate: value ?? 0 }))}
              />
            </Form.Item>
            <Form.Item label="Judge 模型">
              <Select
                aria-label="Judge 模型"
                data-testid="judge-select"
                style={{ width: "100%" }}
                placeholder="请选择 Judge 模型"
                value={draft.judgeModelId ?? undefined}
                onChange={(value?: string) =>
                  setDraft((state) => ({ ...state, judgeModelId: value ?? null }))
                }
                options={settingsData.models.judges.map((model) => ({
                  value: model.id,
                  disabled: !model.available,
                  label: `${model.name}${model.available ? "" : "（不可用）"}`,
                }))}
              />
            </Form.Item>
            <Form.Item label="Embedding 模型">
              <Select
                aria-label="Embedding 模型"
                data-testid="embed-select"
                style={{ width: "100%" }}
                placeholder="请选择 Embedding 模型"
                value={draft.embeddingModelId ?? undefined}
                onChange={(value?: string) =>
                  setDraft((state) => ({ ...state, embeddingModelId: value ?? null }))
                }
                options={settingsData.models.embeddings.map((model) => ({
                  value: model.id,
                  disabled: !model.available,
                  label: `${model.name}${model.available ? "" : "（不可用）"}`,
                }))}
              />
            </Form.Item>
            {modelError && (
              <Form.Item>
                <Text type="danger">{modelError}</Text>
              </Form.Item>
            )}
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
            {thresholdError && (
              <Form.Item>
                <Text type="danger">请输入 0–100 的整数</Text>
              </Form.Item>
            )}
            <Form.Item label="每日上限">
              <InputNumber
                min={1}
                max={10_000}
                style={{ width: "100%" }}
                value={draft.dailyCap ?? settingsData.settings.dailyCap}
                onChange={(value) => setDraft((state) => ({ ...state, dailyCap: value ?? 1 }))}
              />
            </Form.Item>
            <Button type="primary" block onClick={saveSettings}>
              保存
            </Button>
          </Form>
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
    <Form.Item label={label}>
      <InputNumber
        aria-label={label}
        style={{ width: "100%" }}
        value={value}
        onChange={(next) => onChange(Number(next ?? 0))}
      />
    </Form.Item>
  );
}
