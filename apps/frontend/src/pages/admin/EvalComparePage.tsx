import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Alert,
  Button,
  Empty,
  Flex,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
  type TableColumnsType,
} from "antd";
import type {
  CompareMetricKey,
  EvalCompareResponse,
  EvalGateStatus,
  EvalRunListItem,
} from "@codecrush/contracts";
import {
  EvalCompareIncomparableError,
  getEvalCompare,
  getEvalGate,
  getEvalRuns,
} from "../../api/client";
import { downloadCsv, type CsvValue } from "../../utils/csv";
import {
  COMPARABLE_RUN_STATUSES,
  SIGNIFICANT_DELTA,
  formatHitRate5,
  formatNdcg5,
} from "./evalShared";
import { SideBySidePanel, type ReplayScores } from "./ReplayModal";

const { Title, Text } = Typography;

const METRIC_LABEL: Record<CompareMetricKey, string> = {
  faithfulness: "忠实度",
  answerRelevancy: "相关性",
  contextPrecision: "上下文精确率",
  correctness: "正确率",
  citation: "引用",
  contextRecall: "上下文召回",
  ndcg5: "NDCG@5",
  hitRate5: "命中率@5",
};

/** F8：NDCG 显示两位小数、命中率显示 %、其余整数（与屏3 记分卡同口径）。 */
function fmtMetric(key: CompareMetricKey, v: number | null): string {
  if (v === null) return "—";
  if (key === "ndcg5") return formatNdcg5(v);
  if (key === "hitRate5") return formatHitRate5(v);
  return String(v);
}

function DeltaCell({ delta, significant }: { delta: number | null; significant: boolean }) {
  if (delta === null) return <Text type="secondary">—</Text>;
  if (!significant) {
    return <Text type="secondary">— 无显著差异</Text>;
  }
  if (delta >= SIGNIFICANT_DELTA) return <Text style={{ color: "#52c41a" }}>▲ +{delta}</Text>;
  if (delta <= -SIGNIFICANT_DELTA) return <Text style={{ color: "#ff4d4f" }}>▼ {delta}</Text>;
  return <Text type="secondary">—</Text>;
}

interface BannerTier {
  type: "success" | "warning" | "info" | "error";
  text: string;
}

/** §17.4 结论横幅四档：绿(Δ≥3 且变差=0)/橙(Δ≥3 有变差)/灰(|Δ|<3)/红(Δ≤-3)。 */
function bannerTier(res: EvalCompareResponse): BannerTier {
  const d = res.summary.overallDelta;
  if (d === null) return { type: "info", text: "综合分不可比（一侧未出分）" };
  if (d <= -SIGNIFICANT_DELTA) return { type: "error", text: `综合 ${d} · 不建议上线` };
  if (d >= SIGNIFICANT_DELTA) {
    return res.summary.regressedCount > 0
      ? { type: "warning", text: `综合 +${d} · 可上线，但注意 ${res.summary.regressedCount} 条用例回退` }
      : { type: "success", text: `综合 +${d} · 建议上线` };
  }
  return { type: "info", text: `综合 ${d >= 0 ? "+" : ""}${d} · 无显著差异` };
}

interface MetricRow {
  key: CompareMetricKey;
  a: number | null;
  b: number | null;
  delta: number | null;
  significant: boolean;
}

export default function EvalComparePage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const a = params.get("a") ?? "";
  const b = params.get("b") ?? "";

  const [runs, setRuns] = useState<EvalRunListItem[]>([]);
  const [data, setData] = useState<EvalCompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [incomparable, setIncomparable] = useState(false);
  const [sidePair, setSidePair] = useState<{ seq: number; question: string } | null>(null);
  // B1/F5：上线门禁态。默认「关 + 无 issue」＝不拦（与后端 fail-open 同向）。
  const [gate, setGate] = useState<EvalGateStatus>({ enabled: false, issues: [] });

  // 选择器态：列出终态 run（缺 a/b 时用）。
  useEffect(() => {
    void getEvalRuns()
      .then(setRuns)
      .catch(() => setRuns([]));
  }, []);

  const load = useCallback(async () => {
    if (!a || !b) {
      setData(null);
      return;
    }
    setLoading(true);
    setIncomparable(false);
    try {
      setData(await getEvalCompare(a, b));
    } catch (err) {
      setData(null);
      if (err instanceof EvalCompareIncomparableError) setIncomparable(true);
      else message.error(err instanceof Error ? err.message : "对比失败");
    } finally {
      setLoading(false);
    }
  }, [a, b]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * B1/F5：拉门禁结论。走只读端点 `GET :id/eval-gate`，**不建 ReleaseCheck**——
   * 用户还没点上线，不该为看一个按钮态就产生一次预演副作用。
   *
   * 五种 code 全部由后端给出，前端**不复算任何门禁规则**，只判「有没有 issue」。
   * 取不到就当没门禁（fail-open，与后端同向）：前端多拦一层不会更安全，
   * 只会在基础设施抖动时把人挡在门外。
   */
  useEffect(() => {
    if (!data) return;
    let alive = true;
    // 先清空再取：切换 run 对时，上一对的门禁结论会在新数据落地到新结论到手之间
    // 多渲染一帧——那一帧会把 A 对的「可上线」结论盖在 B 对身上。
    setGate({ enabled: false, issues: [] });
    void getEvalGate(data.b.applicationId, data.b.configVersionId)
      .then((s) => {
        if (alive) setGate(s);
      })
      .catch(() => {
        if (alive) setGate({ enabled: false, issues: [] });
      });
    return () => {
      alive = false;
    };
  }, [data]);

  // 选择器：同评测集的终态 run。
  const comparableRuns = runs.filter((r) => COMPARABLE_RUN_STATUSES.includes(r.status));
  const selectedA = comparableRuns.find((r) => r.id === a);
  const selectedB = comparableRuns.find((r) => r.id === b);
  const runOptions = (counterpart: EvalRunListItem | undefined) =>
    comparableRuns.map((r) => ({
      value: r.id,
      label: `${r.setName} · ${r.configVersionLabel}`,
      disabled: counterpart !== undefined && r.setId !== counterpart.setId,
    }));

  if (incomparable) {
    return (
      <div>
        <Title level={4}>版本对比</Title>
        <Alert
          type="error"
          message="两次评测的题库版本不一致，结论不可比"
          action={
            <Button size="small" onClick={() => navigate("/admin/eval/sets")}>
              用当前题库重跑基线
            </Button>
          }
        />
      </div>
    );
  }

  if (!a || !b) {
    return (
      <div>
        <Title level={4}>版本对比</Title>
        <Text type="secondary">选择同一评测集的两个 run 进行对比</Text>
        <Flex gap={12} style={{ marginTop: 16 }}>
          <Select
            aria-label="基线 run"
            style={{ minWidth: 260 }}
            placeholder="基线（较早）"
            value={a || undefined}
            onChange={(v) => setParams({ a: v, ...(b ? { b } : {}) })}
            options={runOptions(selectedB)}
          />
          <Select
            aria-label="候选 run"
            style={{ minWidth: 260 }}
            placeholder="候选（较新）"
            value={b || undefined}
            onChange={(v) => setParams({ ...(a ? { a } : {}), b: v })}
            options={runOptions(selectedA)}
          />
        </Flex>
      </div>
    );
  }

  if (loading || !data) {
    return (
      <Flex justify="center" style={{ padding: 48 }}>
        <Spin />
      </Flex>
    );
  }

  const tier = bannerTier(data);
  const metricRows: MetricRow[] = data.metrics;
  const scoresOf = (side: EvalCompareResponse["cases"][number]["a"]): ReplayScores => ({
    faithfulness: side.scores.faithfulness ?? null,
    answerRelevancy: side.scores.answerRelevancy ?? null,
    contextPrecision: side.scores.contextPrecision ?? null,
  });
  const regressedCases = data.cases.filter((c) => c.regressed);
  const sideCase = sidePair ? data.cases.find((c) => c.seq === sidePair.seq) : undefined;

  const metricColumns: TableColumnsType<MetricRow> = [
    { title: "指标", dataIndex: "key", render: (k: CompareMetricKey) => METRIC_LABEL[k] },
    { title: `基线 ${data.a.configVersionLabel}`, key: "a", render: (_, r) => fmtMetric(r.key, r.a) },
    { title: `候选 ${data.b.configVersionLabel}`, key: "b", render: (_, r) => fmtMetric(r.key, r.b) },
    { title: "Δ", key: "delta", render: (_, r) => <DeltaCell delta={r.delta} significant={r.significant} /> },
  ];

  const exportCsv = () => {
    const table: CsvValue[][] = [
      ["指标", "基线", "候选", "Δ"],
      ...metricRows.map((m) => [METRIC_LABEL[m.key], m.a, m.b, m.delta]),
      [],
      ["#", "问题", "基线判定", "候选判定"],
      ...data.cases.map((c) => [c.seq, c.question, c.a.verdict, c.b.verdict]),
    ];
    downloadCsv(`eval-compare-${a}-${b}.csv`, table, {
      alwaysQuote: true,
      neutralizeFormulas: true,
    });
  };

  // 门禁开启且存在任一门禁 issue ⇒ 禁用引导按钮，原因取第一条。
  const gateBlocked = gate.enabled && gate.issues.length > 0;
  const gateReason = gate.issues[0]?.message ?? "";

  /**
   * 原型 `:621`「跳应用发布页，**发布卡片显示评测摘要**」——
   * 结论参数在**门禁开与关两态下都要携带**（关闭态的价值就在于「始终可点 + 带着结论过去」）。
   * overallDelta 可能为 null（某侧无已评用例），此时传空串而不是 0——
   * NULL 不退化为 0，0 会被读成「持平」。
   */
  const releaseUrl =
    `/admin/applications/${data.b.applicationId}?fromCompare=${a}_${b}` +
    `&regressed=${data.summary.regressedCount}` +
    `&delta=${data.summary.overallDelta ?? ""}`;

  return (
    <div>
      <Title level={4}>版本对比</Title>

      <Alert type={tier.type} message={tier.text} style={{ marginBottom: 8 }} />
      {data.summary.judgeMismatch && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          两次 run 的裁判模型不同，分数可比性弱
        </Text>
      )}

      <Table<MetricRow>
        style={{ marginTop: 16 }}
        rowKey="key"
        size="small"
        pagination={false}
        columns={metricColumns}
        dataSource={metricRows}
        expandable={{
          expandedRowRender: (row) => (
            <Table
              size="small"
              rowKey="caseId"
              pagination={false}
              dataSource={data.cases}
              columns={[
                { title: "#", dataIndex: "seq", width: 56 },
                { title: "问题", dataIndex: "question" },
                { title: "基线", key: "a", render: (_, c) => fmtMetric(row.key, c.a.scores[row.key] ?? null) },
                { title: "候选", key: "b", render: (_, c) => fmtMetric(row.key, c.b.scores[row.key] ?? null) },
              ]}
            />
          ),
        }}
      />

      {/* §8「质量之外」：延迟/Token 黄底行常显。 */}
      <div style={{ background: "#fffbe6", border: "1px solid #ffe58f", borderRadius: 6, padding: "8px 12px", marginTop: 8, fontSize: 13 }}>
        <Space size={24}>
          <span>
            P95 延迟：基线 {data.latency.aP95Ms ?? "—"}ms · 候选 {data.latency.bP95Ms ?? "—"}ms
          </span>
          <span>
            每题均 Token：基线 {data.tokens.aAvgPerCase ?? "—"} · 候选 {data.tokens.bAvgPerCase ?? "—"}
          </span>
        </Space>
      </div>

      {/* 逐用例汇总 */}
      <Flex gap={8} align="center" style={{ marginTop: 16 }} wrap>
        <Tag color="green">变好 {data.summary.improvedCount}</Tag>
        <Tag color="red">变差 {data.summary.regressedCount}</Tag>
        <Tag>持平 {data.summary.flatCount}</Tag>
        {data.summary.excludedCount > 0 && <Tag color="default">不可比 {data.summary.excludedCount}</Tag>}
      </Flex>
      {regressedCases.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {regressedCases.map((c) => (
            <Flex key={c.caseId} gap={8} align="center" style={{ fontSize: 13, marginBottom: 4 }}>
              <span>
                #{c.seq} {c.question}（{c.a.minScore ?? "—"}→{c.b.minScore ?? "—"}）
              </span>
              <Button size="small" onClick={() => setSidePair({ seq: c.seq, question: c.question })}>
                并排查看
              </Button>
            </Flex>
          ))}
        </div>
      )}

      <Flex gap={12} style={{ marginTop: 24 }}>
        <Button onClick={exportCsv}>导出报告</Button>
        {/*
          原型 §17.4（`:621`）：「门禁关:始终可点(跳发布页携带结论);
          门禁开:不满足条件 disabled + 原因(「存在 5 条回退用例」)」。
          判据取最简一致规则——门禁开启且存在任一门禁 issue ⇒ disabled，
          原因取第一条。这条规则自动覆盖 REGRESSION/OVERALL_DROP/NO_RUN/
          STALE_RUN/UNAVAILABLE 五种（原型 §8 是三项合取，无 run / 过期同样不满足）。
          注意：这是**引导层**的硬，后端始终软放行——用户仍可从应用详情页正常上线。
        */}
        <Tooltip title={gateBlocked ? gateReason : ""}>
          {/* disabled 的 Button 不派发鼠标事件，需外包一层才能触发 Tooltip */}
          <span>
            <Button
              type="primary"
              disabled={gateBlocked}
              onClick={() => navigate(releaseUrl)}
            >
              通过评测，去上线 {data.b.configVersionLabel} →
            </Button>
          </span>
        </Tooltip>
      </Flex>

      <Modal
        open={sideCase !== undefined}
        onCancel={() => setSidePair(null)}
        footer={null}
        width={820}
        title={sidePair ? `#${sidePair.seq} ${sidePair.question}` : ""}
      >
        {sideCase && (
          <SideBySidePanel
            left={{
              versionLabel: data.a.configVersionLabel,
              answer: sideCase.a.answer,
              scores: scoresOf(sideCase.a),
              traceId: sideCase.a.traceId,
            }}
            right={{
              versionLabel: data.b.configVersionLabel,
              answer: sideCase.b.answer,
              scores: scoresOf(sideCase.b),
              traceId: sideCase.b.traceId,
            }}
          />
        )}
      </Modal>

      {data.cases.length === 0 && <Empty description="无逐用例数据" />}
    </div>
  );
}
