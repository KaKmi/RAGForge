import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Alert,
  Button,
  Card,
  Drawer,
  Dropdown,
  Empty,
  Flex,
  Popconfirm,
  Progress,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
  type MenuProps,
  type TableColumnsType,
} from "antd";
import { Link, useParams } from "react-router-dom";
import type {
  EvalMetricKey,
  EvalRunReport,
  EvalRunRepeat,
  EvalRunResult,
  EvalRunStatus,
  EvalVerdict,
} from "@codecrush/contracts";
import {
  ApiError,
  createGapItem,
  getEvalRunReport,
  setEvalResultIgnored,
  stopEvalRun,
} from "../../api/client";
import { formatHitRate5, formatNdcg5 } from "./evalShared";
import ReplayModal, { type ReplaySource } from "./ReplayModal";

const { Title, Text } = Typography;

/** 原型 §7 屏3「评测报告」/ §17.3 组件与状态矩阵 / §18.A 状态机 / §19.2 文案。 */

const POLL_MS = 3000;

const RUN_STATUS_LABEL: Record<EvalRunStatus, string> = {
  queued: "排队",
  running: "运行中",
  done: "完成",
  partial: "部分完成",
  budget_stop: "预算中断",
  failed: "失败",
};
const RUN_STATUS_COLOR: Record<EvalRunStatus, string | undefined> = {
  queued: undefined,
  running: "processing",
  done: "green",
  partial: "gold",
  budget_stop: "orange",
  failed: "red",
};

/** §7 判定 + 018 §11 补全的 timeout/unscored（后两者不进 pass/weak/low 分母）。 */
const VERDICT_LABEL: Record<EvalVerdict, string> = {
  pass: "通过",
  weak: "偏低",
  low: "低分",
  timeout: "超时",
  unscored: "未评⚠",
};
const VERDICT_COLOR: Record<EvalVerdict, string | undefined> = {
  pass: "green",
  weak: "gold",
  low: "red",
  timeout: "volcano",
  unscored: undefined,
};

const METRIC_LABEL: Record<EvalMetricKey, string> = {
  faithfulness: "忠实度",
  answerRelevancy: "相关性",
  correctness: "正确率",
  contextPrecision: "精确率",
  citation: "引用",
};

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

/** 判定档位配色（018 §11 / 契约：<60 low、60-79 weak、≥80 pass）。null 不着色。 */
function scoreColor(score: number | null): string | undefined {
  if (score === null) return undefined;
  if (score < 60) return "#ff4d4f";
  if (score < 80) return "#faad14";
  return "#52c41a";
}

/** 分数单元格：**null 一律「—」，绝不是 0**（本波中心不变式）。 */
function ScoreCell({ score, metric }: { score: number | null; metric: EvalMetricKey }) {
  return (
    <span data-testid={`cell-${metric}`} style={{ color: scoreColor(score) }}>
      {score === null ? "—" : score}
    </span>
  );
}

type Row = EvalRunResult & { skipped: boolean };

/**
 * 加载失败的**两种**性质（QA P3-4）：
 *  · `not_found` —— 服务器明确答 404，「不存在」是它说的，可以照直转述；
 *  · `load_failed` —— 网络故障 / 响应不满足契约（Zod 抛错）。报告很可能**在**，是我们没读回来。
 */
type LoadError = { kind: "not_found" } | { kind: "load_failed"; detail: string };

export default function EvalRunDetailPage() {
  const { runId = "" } = useParams();
  const [report, setReport] = useState<EvalRunReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  const [sortKey, setSortKey] = useState<EvalMetricKey | "min">("min");
  const [evidenceOf, setEvidenceOf] = useState<Row | null>(null);
  const [stopping, setStopping] = useState(false);
  const [replaySource, setReplaySource] = useState<ReplaySource | null>(null);
  /** B2a Task 8：正在入池的行（防连点——两次往返里第二次会回 joinedExisting，看起来像自己加重了）。 */
  const [poolingRow, setPoolingRow] = useState<string | null>(null);
  /** B2b：正在切忽略态的行 caseId（防连点——连点会让最后一次往返决定最终态，与用户看到的相反）。 */
  const [ignoringRow, setIgnoringRow] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReport(await getEvalRunReport(runId));
      setLoadError(null);
    } catch (error) {
      // §17：失败保留上次数据，不清空不白屏（轮询期间尤其重要）
      message.error(error instanceof Error ? error.message : "评测报告加载失败");
      // 「服务器说没有这条」≠「没读回来」。只有 404 才是前者；Zod 解析失败/网络故障
      // 若也说「报告不存在」，就是在**断言一件没被证实的事**（QA P3-4：实际误导了排查）。
      setLoadError(
        error instanceof ApiError && error.status === 404
          ? { kind: "not_found" }
          : { kind: "load_failed", detail: error instanceof Error ? error.message : String(error) },
      );
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  // §17.3：queued/running 时 3s 轮询；终态清 interval（018 已知取舍 8：轮询而非 SSE）。
  const status = report?.run.status;
  useEffect(() => {
    if (status !== "queued" && status !== "running") return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [status, load]);

  const rows = useMemo<Row[]>(() => {
    if (!report) return [];
    const results: Row[] = report.results.map((item) => ({ ...item, skipped: false }));
    // 未跑到的用例不写结果行（018 §10）→ 由 skipped 数组补成灰行，指标全「—」。
    const skipped: Row[] = report.skipped.map((item) => ({
      ...item,
      faithfulness: null,
      answerRelevancy: null,
      contextPrecision: null,
      correctness: null,
      citation: null,
      contextRecall: null,
      ndcg5: null,
      hitRate5: null,
      minMetric: null,
      minScore: null,
      verdict: "unscored" as const,
      evidence: {},
      previewTraceId: null,
      answer: "",
      durationMs: 0,
      error: null,
      repeatCount: 1,
      repeats: [],
      // 没跑过的用例谈不上「忽略」——它连结果行都没有，标记忽略的行尾操作对它也是禁用的。
      ignoredAt: null,
      skipped: true,
    }));
    const score = (row: Row) => (sortKey === "min" ? row.minScore : row[sortKey]);
    return [...results, ...skipped].sort((a, b) => {
      // 未跑的恒沉底：它不是「差」，是「没测」。
      if (a.skipped !== b.skipped) return a.skipped ? 1 : -1;
      const [x, y] = [score(a), score(b)];
      // 「坏的浮顶」：升序；未评（null）无分可比 → 沉到已评样本之后。
      if (x === null && y === null) return a.seq - b.seq;
      if (x === null) return 1;
      if (y === null) return -1;
      return x - y || a.seq - b.seq;
    });
  }, [report, sortKey]);

  const stop = async () => {
    setStopping(true);
    try {
      await stopEvalRun(runId);
      message.success("已请求停止");
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "停止失败");
    } finally {
      setStopping(false);
    }
  };

  if (loading && !report) {
    return (
      <Flex justify="center" style={{ padding: 64 }}>
        <Spin />
      </Flex>
    );
  }
  if (!report) {
    // 404 之外的失败**不许**说「不存在」——它是本地故障，报告可能好端端在服务器上。
    if (loadError?.kind === "load_failed") {
      return (
        <Alert
          type="error"
          showIcon
          message="评测报告加载失败"
          description={
            <>
              <div>未能读取报告，这不代表它不存在（可能是网络故障或响应格式不符）。</div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {loadError.detail}
              </Text>
              <div style={{ marginTop: 12 }}>
                <Button size="small" onClick={() => void load()}>
                  重试
                </Button>
              </div>
            </>
          }
        />
      );
    }
    return <Empty description="评测报告不存在" />;
  }

  const { run, scorecard } = report;
  // F5：进度分母是 unit 数（totalCases × repeatCount），doneCases 后端已按 unit 计。
  const totalUnits = run.totalCases * run.repeatCount;
  const percent = totalUnits > 0 ? Math.round((run.doneCases / totalUnits) * 100) : 0;

  /**
   * B2a Task 8：行尾「加入问题池」（021 决策 B：**前端组合**，后端不产生 `eval-runs → gaps` 反向边）。
   *
   * `source` 是 **`offline_run`** 而不是 `manual_trace`——这条样本来自离线重跑，不是真实用户流量。
   * 后端据此把它排除在 `freq30d` 的 30 天滚动窗口之外（只进累计 `freq`），
   * 也排除在 `followUpRatio` 的分母之外。传错会让离线重跑的量污染「最近有多少真实用户踩到」。
   *
   * `traceStartTime` **要传**（peer review 纠正了我最初"不传"的判断）：它不止喂 `freq30d`，
   * 还决定 `traceExpired`（NULL ⇒ 恒 false ⇒ 30 天后那条 preview trace 链接仍是蓝的、
   * 点进去撞「未找到该 Trace」，而同簇的 online 成员会正确置灰——同一张表两种表现）
   * 与簇内排序（`NULLS LAST` 恒沉底）。传它**不会**污染任何统计：上面两个口径都按 `source`
   * 独立排除了 `offline_run`。语义上它就是「这个样本的 trace 何时产生」，对离线重跑而言
   * 就是 run 的开始时间；「是不是真实流量」由 `source` 列单独承载。
   * 必须 `toISOString()` 归一化：`run.startedAt` 是 `.datetime({offset:true})`，
   * 而 gaps 请求侧是 `.datetime()`（不收 offset），带 `+08:00` 直传会在客户端 zod 就炸。
   */
  const addRowToPool = async (row: Row) => {
    if (!row.previewTraceId || poolingRow) return;
    setPoolingRow(row.previewTraceId);
    try {
      const startedAt = run.startedAt ? new Date(run.startedAt) : null;
      const result = await createGapItem({
        question: row.question,
        source: "offline_run",
        sourceTraceId: row.previewTraceId,
        ...(startedAt && !Number.isNaN(startedAt.getTime()) && startedAt.getTime() <= Date.now()
          ? { traceStartTime: startedAt.toISOString() }
          : {}),
      });
      if (result.joinedExisting) {
        // 原型 §19.2 `:753` 逐字：「该问题已在缺口『…』(×N) 中 · 查看」。
        // 尾部的「查看」是这条 toast 里唯一可执行的部分，不能省。
        message.info({
          content: (
            <span>
              该问题已在缺口『{result.representativeQuestion}』(×{result.freq}) 中 ·{" "}
              <Link to="/admin/gaps">查看</Link>
            </span>
          ),
        });
      } else {
        message.success("已加入问题池");
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "加入问题池失败");
    } finally {
      setPoolingRow(null);
    }
  };

  /**
   * B2b：行尾「标记忽略」/「取消忽略」（原型 `:322`）。**逐 case 粒度**——后端按 caseId
   * 覆盖该 case 在本 run 内的全部重复行，不牵连缺口簇里的其他成员。
   *
   * 成功后重新 `load()` 而不是本地改 state：`ignoredAt` 是服务端时间戳，本地猜一个
   * 会让「什么时候忽略的」这条信息在刷新前后不一致。
   */
  const toggleRowIgnored = async (row: Row) => {
    if (row.skipped || ignoringRow) return;
    const next = row.ignoredAt === null;
    setIgnoringRow(row.caseId);
    try {
      await setEvalResultIgnored(runId, row.caseId, next);
      message.success(next ? "已标记忽略" : "已取消忽略");
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "操作失败");
    } finally {
      setIgnoringRow(null);
    }
  };

  // F7：行尾「重放该条」打开 ReplayModal（预填 run 的 app/version + 行 question + previewTraceId）。
  const onReplayRow = (row: Row) => {
    if (!row.previewTraceId) return;
    setReplaySource({
      applicationId: run.applicationId,
      configVersionId: run.configVersionId,
      question: row.question,
      sourceTraceId: row.previewTraceId,
      originalAnswer: row.answer,
      originalScores: {
        faithfulness: row.faithfulness,
        answerRelevancy: row.answerRelevancy,
        contextPrecision: row.contextPrecision,
      },
      originalVersionLabel: run.configVersionLabel,
    });
  };

  const columns: TableColumnsType<Row> = [
    { title: "#", dataIndex: "seq", key: "seq", width: 56 },
    {
      title: "问题",
      dataIndex: "question",
      key: "question",
      render: (text: string, row) => (
        <span
          style={{
            // 已忽略与未跑都置灰，但成因不同 → 已忽略再加一个 tag 显式说明，
            // 否则两种灰在同一张表里无法区分（「没测」vs「测了但不算数」）。
            color: row.skipped || row.ignoredAt !== null ? "rgba(0,0,0,.45)" : undefined,
          }}
        >
          {text}
          {row.ignoredAt !== null && (
            <Tag style={{ marginLeft: 8 }} data-testid="ignored-tag">
              已忽略
            </Tag>
          )}
        </span>
      ),
    },
    ...(["faithfulness", "answerRelevancy", "correctness", "contextPrecision"] as const).map(
      (metric) => ({
        title: METRIC_LABEL[metric],
        key: metric,
        width: 90,
        render: (_: unknown, row: Row) => <ScoreCell metric={metric} score={row[metric]} />,
      }),
    ),
    {
      title: "判定",
      key: "verdict",
      width: 100,
      // §17.3「判定筛选：低分/偏低/通过/未评/超时」（+ 未跑：stop/budget_stop 的剩余用例）
      filters: [
        { text: "低分", value: "low" },
        { text: "偏低", value: "weak" },
        { text: "通过", value: "pass" },
        { text: "未评", value: "unscored" },
        { text: "超时", value: "timeout" },
        { text: "未跑", value: "skipped" },
      ],
      onFilter: (value, row) =>
        value === "skipped" ? row.skipped : !row.skipped && row.verdict === value,
      render: (_: unknown, row) =>
        row.skipped ? (
          <Tag style={{ margin: 0 }}>未跑</Tag>
        ) : (
          <Tag color={VERDICT_COLOR[row.verdict]} style={{ margin: 0 }}>
            {VERDICT_LABEL[row.verdict]}
          </Tag>
        ),
    },
    {
      title: "操作",
      key: "action",
      width: 150,
      render: (_: unknown, row) =>
        row.skipped ? (
          <Text type="secondary">—</Text>
        ) : (
          <Flex gap={10} align="center">
            {/* 原型 §7：「trace」= 评测与 Trace 的直接接点（preview trace 详情） */}
            {row.previewTraceId ? (
              <Link to={`/admin/traces/${row.previewTraceId}`}>trace</Link>
            ) : (
              <Text type="secondary">trace</Text>
            )}
            <Button
              type="link"
              size="small"
              style={{ padding: 0, height: "auto" }}
              onClick={() => setEvidenceOf(row)}
            >
              判分依据
            </Button>
            {/*
              原型 §7 行尾「…」快捷操作（`:322`：重放该条 / 加入问题池 / 标记忽略）三项齐全。
              「标记忽略」落 `eval_run_results.ignored_at`（B2b 迁移 0028），**逐 case** 粒度：
              后端按 caseId 覆盖该 case 在本 run 内的全部重复行。不做成「顺手忽略整个缺口簇」
              ——那会让一条用例的判断连坐簇里其他所有成员，不是忽略，是误伤。
              它是**叠加标志**：分数与 verdict 全部保留，记分卡不看它，只影响本表的视觉/筛选。
            */}
            <Dropdown
              trigger={["click"]}
              menu={{
                items: [
                  {
                    key: "replay",
                    label: "重放该条",
                    disabled: row.previewTraceId === null,
                    onClick: () => onReplayRow(row),
                  },
                  {
                    key: "pool",
                    label: "加入问题池",
                    // 没跑出 preview trace 就没有可引用的样本 id（`source_trace_id` 是幂等键）。
                    disabled: row.previewTraceId === null || poolingRow !== null,
                    onClick: () => void addRowToPool(row),
                  },
                  {
                    key: "ignore",
                    // 可撤销：已忽略的行菜单项翻成「取消忽略」，同一个入口两态，不另开一项。
                    label: row.ignoredAt === null ? "标记忽略" : "取消忽略",
                    disabled: ignoringRow !== null,
                    onClick: () => void toggleRowIgnored(row),
                  },
                ] satisfies MenuProps["items"],
              }}
            >
              <Button type="link" size="small" style={{ padding: 0, height: "auto" }}>
                …
              </Button>
            </Dropdown>
          </Flex>
        ),
    },
  ];

  return (
    <div>
      <Flex align="center" gap={12} wrap style={{ marginBottom: 12 }}>
        <Title level={4} style={{ margin: 0, marginRight: "auto" }}>
          评测报告
        </Title>
        <Link to="/admin/eval/runs">← 返回评测列表</Link>
      </Flex>

      {/* 原型 §7 概要条：评测集 × 版本 · 时间 · 状态 ｜ 通过/低分 · 耗时 · tokens */}
      <Card size="small" style={{ marginBottom: 8 }}>
        <Flex justify="space-between" gap={12} wrap style={{ fontSize: 12 }}>
          <Space12>
            <span>
              {run.setName} × <b>{run.configVersionLabel}</b> · {formatDateTime(run.createdAt)}
            </span>
            <Tag color={RUN_STATUS_COLOR[run.status]} style={{ margin: 0 }}>
              {RUN_STATUS_LABEL[run.status]}
            </Tag>
          </Space12>
          <Space12>
            <b style={{ color: "#52c41a" }}>通过 {scorecard.passCount}</b>
            <b style={{ color: "#ff4d4f" }}>低分 {scorecard.lowCount}</b>
            {scorecard.weakCount > 0 && <span>偏低 {scorecard.weakCount}</span>}
            {/* 018 已知取舍 2：超时/未评必须显眼，否则「全崩」会被误读成「没测」 */}
            {scorecard.timeoutCount > 0 && (
              <b style={{ color: "#d4380d" }}>超时 {scorecard.timeoutCount}</b>
            )}
            {scorecard.unscoredCount > 0 && <span>未评 {scorecard.unscoredCount}</span>}
            {scorecard.skippedCount > 0 && <span>未跑 {scorecard.skippedCount}</span>}
            <span>{formatDuration(run.durationMs)}</span>
            {/* 018 决策 G：token 是尽力而为，必须写明口径，不假装精确 */}
            <Tooltip title="token 用量为已知上报之和，部分 provider 不回传">
              <span>{Math.round(run.tokensUsed / 1000)}k tokens</span>
            </Tooltip>
          </Space12>
        </Flex>
      </Card>

      <StatusBanner report={report} percent={percent} stopping={stopping} onStop={stop} />

      {/* 记分卡两块（原型 §7：检索层 / 生成层）。点某指标 → 逐用例表按该指标升序（§17.3）。 */}
      <Flex gap={8} wrap style={{ marginBottom: 8 }}>
        <Card
          size="small"
          style={{ flex: "1 1 320px" }}
          title={<span style={{ color: "#1677ff" }}>检索层</span>}
        >
          <Flex wrap gap={8}>
            {/* 精确率是 LLM 判分（不依赖 gold）——始终可点排序、显真值 */}
            <MetricCell
              label="Context Precision"
              metric="contextPrecision"
              aggregate={scorecard.retrieval.contextPrecision}
              active={sortKey === "contextPrecision"}
              onClick={() => setSortKey("contextPrecision")}
            />
            {/* gold-docs 三项（F2）：无 gold（withGold=0）时显「—」，格式化按原型 §7。 */}
            <RetrievalMetricCell
              label="Context Recall"
              testId="scorecard-contextRecall"
              aggregate={scorecard.retrieval.contextRecall}
              noGold={scorecard.retrieval.goldCoverage.withGold === 0}
            />
            <RetrievalMetricCell
              label="NDCG@5"
              testId="scorecard-ndcg5"
              aggregate={scorecard.retrieval.ndcg5}
              noGold={scorecard.retrieval.goldCoverage.withGold === 0}
              format={formatNdcg5}
            />
            <RetrievalMetricCell
              label="命中率@5"
              testId="scorecard-hitRate5"
              aggregate={scorecard.retrieval.hitRate5}
              noGold={scorecard.retrieval.goldCoverage.withGold === 0}
              format={formatHitRate5}
            />
          </Flex>
          {/* 覆盖率行（原型 §7「gold 38/50 已标」）：有 gold → 已评/gold 计数；无 gold → 空态逐字。 */}
          <Text type="secondary" style={{ fontSize: 11 }}>
            {scorecard.retrieval.goldCoverage.withGold === 0
              ? `未标 gold docs，0/${scorecard.retrieval.goldCoverage.total}`
              : `已评 ${scorecard.retrieval.contextPrecision.scoredCount}/${scorecard.retrieval.contextPrecision.total}` +
                ` · gold ${scorecard.retrieval.goldCoverage.withGold}/${scorecard.retrieval.goldCoverage.total}`}
          </Text>
        </Card>
        <Card
          size="small"
          style={{ flex: "1 1 320px" }}
          title={<span style={{ color: "#722ed1" }}>生成层</span>}
        >
          <Flex wrap gap={8}>
            <MetricCell
              label="Faithfulness"
              metric="faithfulness"
              aggregate={scorecard.generation.faithfulness}
              active={sortKey === "faithfulness"}
              onClick={() => setSortKey("faithfulness")}
            />
            <MetricCell
              label="Relevancy"
              metric="answerRelevancy"
              aggregate={scorecard.generation.answerRelevancy}
              active={sortKey === "answerRelevancy"}
              onClick={() => setSortKey("answerRelevancy")}
            />
            <MetricCell
              label="Correctness"
              metric="correctness"
              aggregate={scorecard.generation.correctness}
              active={sortKey === "correctness"}
              onClick={() => setSortKey("correctness")}
            />
            <MetricCell
              label="Citation"
              metric="citation"
              aggregate={scorecard.generation.citation}
              active={sortKey === "citation"}
              onClick={() => setSortKey("citation")}
            />
          </Flex>
        </Card>
      </Flex>

      <Card
        size="small"
        title="逐用例"
        extra={
          <Text type="secondary" style={{ fontSize: 12 }}>
            {sortKey === "min" ? "按最差指标升序（坏的浮顶）" : `按 ${METRIC_LABEL[sortKey]} 升序`}
            {sortKey !== "min" && (
              <Button type="link" size="small" onClick={() => setSortKey("min")}>
                恢复默认
              </Button>
            )}
          </Text>
        }
      >
        <Table<Row>
          rowKey={(row) => `${row.caseId}-${row.caseVersion}`}
          columns={columns}
          dataSource={rows}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          locale={{ emptyText: <Empty description="暂无用例结果" /> }}
          // skipped 灰行（§17.3）
          onRow={(row) => (row.skipped ? { style: { background: "#fafafa" } } : {})}
          // F5：每题重复 >1 的行可展开，看每次重复的逐次明细（顶层为非空均值）。
          expandable={{
            rowExpandable: (row) => !row.skipped && row.repeatCount > 1,
            expandedRowRender: (row) => <RepeatDetail repeats={row.repeats} />,
          }}
        />
      </Card>

      <EvidenceDrawer row={evidenceOf} onClose={() => setEvidenceOf(null)} />

      <ReplayModal
        open={replaySource !== null}
        source={replaySource}
        onClose={() => setReplaySource(null)}
      />
    </div>
  );
}

/** 概要条内的小间距行——避免为一处布局引入 antd Space 的额外包裹语义。 */
function Space12({ children }: { children: ReactNode }) {
  return (
    <Flex align="center" gap={12} wrap>
      {children}
    </Flex>
  );
}

/** §17.3「运行中横幅」+「非『完成』状态报告顶部横幅说明」（§7 run 状态机行）。 */
function StatusBanner({
  report,
  percent,
  stopping,
  onStop,
}: {
  report: EvalRunReport;
  percent: number;
  stopping: boolean;
  onStop: () => Promise<void>;
}) {
  const { run, scorecard } = report;
  // F5：进度分母是 unit 数（totalCases × repeatCount），与顶层 percent 同口径。
  const totalUnits = run.totalCases * run.repeatCount;
  if (run.status === "done") return null;

  if (run.status === "queued" || run.status === "running") {
    return (
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 8 }}
        title={
          run.status === "queued" ? "排队中，等待执行" : `运行中 · ${run.doneCases}/${totalUnits}`
        }
        description={<Progress percent={percent} status="active" />}
        action={
          <Popconfirm
            // §19.2 逐字：「停止后已完成的 {n} 条保留，未运行的不再执行？」
            title={`停止后已完成的 ${run.doneCases} 条保留，未运行的不再执行？`}
            okText="停止"
            cancelText="取消"
            okButtonProps={{ danger: true, loading: stopping }}
            onConfirm={onStop}
          >
            <Button size="small" danger>
              停止
            </Button>
          </Popconfirm>
        }
      />
    );
  }

  const banner: Record<
    "partial" | "budget_stop" | "failed",
    { type: "warning" | "error"; text: string }
  > = {
    // §18.A：「手动停止，已完成 23/50」+ 剩余标 skipped
    partial: {
      type: "warning",
      text: `手动停止，已完成 ${run.doneCases}/${totalUnits}${
        scorecard.skippedCount > 0 ? ` · ${scorecard.skippedCount} 条未跑` : ""
      }`,
    },
    // §18.A：「预算中断(500k)」
    budget_stop: {
      type: "warning",
      text: `预算中断（${Math.round(run.tokenBudget / 1000)}k）· 已完成 ${run.doneCases}/${totalUnits}${
        scorecard.skippedCount > 0 ? ` · ${scorecard.skippedCount} 条未跑` : ""
      }`,
    },
    failed: { type: "error", text: run.error ?? "评测失败" },
  };
  const { type, text } = banner[run.status];
  return <Alert type={type} showIcon style={{ marginBottom: 8 }} title={text} />;
}

type Aggregate = { value: number | null; scoredCount: number; total: number };

/** 已实现指标：分数 + 覆盖率（avg 只按非 NULL 样本算，覆盖率显性表达「未评」占比）。 */
function MetricCell({
  label,
  metric,
  aggregate,
  active,
  onClick,
}: {
  label: string;
  metric: EvalMetricKey;
  aggregate: Aggregate;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip title={`点击按${METRIC_LABEL[metric]}升序排列逐用例`}>
      <Flex
        vertical
        gap={2}
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") onClick();
        }}
        style={{
          flex: "1 1 130px",
          cursor: "pointer",
          padding: "4px 8px",
          borderRadius: 6,
          background: active ? "#f0f5ff" : undefined,
        }}
      >
        <Text style={{ fontSize: 12 }}>{label}</Text>
        <b
          data-testid={`scorecard-${metric}`}
          style={{ fontSize: 18, color: scoreColor(aggregate.value) }}
        >
          {aggregate.value === null ? "—" : aggregate.value}
        </b>
        <Text type="secondary" style={{ fontSize: 11 }}>
          已评 {aggregate.scoredCount}/{aggregate.total}
        </Text>
      </Flex>
    </Tooltip>
  );
}

/**
 * 检索层 gold-docs 三指标（F2）——非 LLM 排序真值、不进 verdict/综合分，故不参与逐用例排序，
 * 只读展示。`noGold`（本 run 快照无任何 gold 标注）→ 显「—」（原型 §7 空态，覆盖率行统一注）。
 */
function RetrievalMetricCell({
  label,
  testId,
  aggregate,
  noGold,
  format,
}: {
  label: string;
  testId: string;
  aggregate: Aggregate;
  noGold: boolean;
  format?: (value: number) => string;
}) {
  const value = aggregate.value;
  const dash = noGold || value === null;
  return (
    <Flex vertical gap={2} style={{ flex: "1 1 130px", padding: "4px 8px" }}>
      <Text style={{ fontSize: 12 }}>{label}</Text>
      <b
        data-testid={testId}
        style={{ fontSize: 18, color: dash ? "rgba(0,0,0,.25)" : scoreColor(value) }}
      >
        {value === null || dash ? "—" : format ? format(value) : value}
      </b>
    </Flex>
  );
}

/** F5：某用例重复次数 >1 时展开的逐次明细（每次的分数 / verdict / trace 链接）。 */
function RepeatDetail({ repeats }: { repeats: EvalRunRepeat[] }) {
  const columns: TableColumnsType<EvalRunRepeat> = [
    {
      title: "次数",
      key: "repeatIndex",
      width: 72,
      render: (_: unknown, r) => `第 ${r.repeatIndex} 次`,
    },
    ...(
      ["faithfulness", "answerRelevancy", "correctness", "contextPrecision", "citation"] as const
    ).map((metric) => ({
      title: METRIC_LABEL[metric],
      key: metric,
      width: 76,
      render: (_: unknown, r: EvalRunRepeat) => (
        <span style={{ color: scoreColor(r[metric]) }}>{r[metric] === null ? "—" : r[metric]}</span>
      ),
    })),
    {
      title: "判定",
      key: "verdict",
      width: 88,
      render: (_: unknown, r) => (
        <Tag color={VERDICT_COLOR[r.verdict]} style={{ margin: 0 }}>
          {VERDICT_LABEL[r.verdict]}
        </Tag>
      ),
    },
    {
      title: "trace",
      key: "trace",
      width: 64,
      render: (_: unknown, r) =>
        r.previewTraceId ? (
          <Link to={`/admin/traces/${r.previewTraceId}`}>trace</Link>
        ) : (
          <Text type="secondary">trace</Text>
        ),
    },
  ];
  return (
    <Table<EvalRunRepeat>
      size="small"
      rowKey={(r) => r.repeatIndex}
      columns={columns}
      dataSource={repeats}
      pagination={false}
    />
  );
}

/** correctness 的 evidence 行形如 `[hit] 要点原文 —— 理由`（correctness.evaluator.ts:103）。 */
const POINT_STATUS: Record<string, { label: string; color: string }> = {
  hit: { label: "一致", color: "green" },
  missing: { label: "缺失", color: "gold" },
  contradicted: { label: "矛盾", color: "red" },
  // F4 Citation：`[supported]`/`[unsupported]`（citation.evaluator：每处引用是否真支持其结论）。
  supported: { label: "支持", color: "green" },
  unsupported: { label: "不支持", color: "red" },
};

/** §17.3「判分依据抽屉 Drawer 560px · eval_results.judge_evidence」。 */
function EvidenceDrawer({ row, onClose }: { row: Row | null; onClose: () => void }) {
  return (
    // 挂在当前页面而非延迟创建 body portal：React 19 + antd v6 开发态下可稳定响应首次点击。
    <Drawer
      title={`判分依据 · #${row?.seq ?? ""}`}
      size={560}
      open={row !== null}
      onClose={onClose}
      getContainer={false}
      rootStyle={{ position: "fixed" }}
      forceRender
    >
      {row && (
        <>
          <Text strong>{row.question}</Text>
          {row.error && <Alert type="error" showIcon style={{ marginTop: 8 }} title={row.error} />}
          {row.answer && (
            <Card size="small" title="回答" style={{ marginTop: 8 }}>
              <Text style={{ whiteSpace: "pre-wrap" }}>{row.answer}</Text>
            </Card>
          )}
          {(
            [
              "faithfulness",
              "answerRelevancy",
              "correctness",
              "contextPrecision",
              "citation",
            ] as const
          ).map((metric) => {
            const lines = row.evidence[metric];
            return (
              <Card
                key={metric}
                size="small"
                style={{ marginTop: 8 }}
                title={
                  <Flex align="center" gap={8}>
                    <span>{METRIC_LABEL[metric]}</span>
                    <b style={{ color: scoreColor(row[metric]) }}>
                      {row[metric] === null ? "—" : row[metric]}
                    </b>
                  </Flex>
                }
              >
                {/*
                    「未评」的判据是**分数为 NULL**，不是 evidence 键缺失：契约里
                    evidence 只收评出来的指标（partialRecord），但反过来「有分无依据」
                    也可能发生（如 contextPrecision 无检索片段时的兜底），那不是未评。
                  */}
                {row[metric] === null ? (
                  <Text type="secondary">该指标未评——裁判失败/超时/无 gold 可对照，不计入均值</Text>
                ) : lines === undefined || lines.length === 0 ? (
                  <Text type="secondary">本次未返回判分依据</Text>
                ) : (
                  lines.map((line, index) => <EvidenceLine key={index} line={line} />)
                )}
              </Card>
            );
          })}
          <RetrievalGoldCard row={row} />
        </>
      )}
    </Drawer>
  );
}

/**
 * 判分依据抽屉的检索层（gold-docs）分数简行（F2）——三项确定性指标**无 LLM evidence**，
 * 只显分数；本用例无 gold（三项全 NULL）→「未标 gold docs」。比对细节留 trace 链接（spec F2）。
 */
function RetrievalGoldCard({ row }: { row: Row }) {
  const noGold = row.contextRecall === null && row.ndcg5 === null && row.hitRate5 === null;
  return (
    <Card size="small" style={{ marginTop: 8 }} title="检索层（gold docs）">
      {noGold ? (
        <Text type="secondary">未标 gold docs</Text>
      ) : (
        <Flex gap={16} wrap>
          <span>
            Context Recall{" "}
            <b style={{ color: scoreColor(row.contextRecall) }}>{row.contextRecall ?? "—"}</b>
          </span>
          <span>
            NDCG@5{" "}
            <b style={{ color: scoreColor(row.ndcg5) }}>
              {row.ndcg5 === null ? "—" : formatNdcg5(row.ndcg5)}
            </b>
          </span>
          <span>
            命中率@5{" "}
            <b style={{ color: scoreColor(row.hitRate5) }}>
              {row.hitRate5 === null ? "—" : formatHitRate5(row.hitRate5)}
            </b>
          </span>
        </Flex>
      )}
    </Card>
  );
}

function EvidenceLine({ line }: { line: string }) {
  const matched = /^\[(\w+)]\s*(.*)$/s.exec(line);
  const status = matched ? POINT_STATUS[matched[1]] : undefined;
  return (
    <Flex gap={8} style={{ marginBottom: 6 }}>
      {status && (
        <Tag color={status.color} style={{ margin: 0, height: 22 }}>
          {status.label}
        </Tag>
      )}
      <Text style={{ fontSize: 12 }}>{status ? matched?.[2] : line}</Text>
    </Flex>
  );
}
