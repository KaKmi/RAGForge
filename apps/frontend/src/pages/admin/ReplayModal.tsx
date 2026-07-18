import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Flex, Input, Modal, Select, Space, Spin, Tabs, Tag, Typography, message } from "antd";
import { Link } from "react-router-dom";
import type { TraceDetailResponse } from "@codecrush/contracts";
import { getApplicationDetail, getTrace } from "../../api/client";
import { streamReplay } from "../../api/sse";
import { ChatStreamError } from "../../api/sse";

const { Text, Paragraph } = Typography;

/** F7：重放的三个即时判分指标（correctness 无 gold 不判、citation 不进重放面板）。 */
export interface ReplayScores {
  faithfulness: number | null;
  answerRelevancy: number | null;
  contextPrecision: number | null;
}

export interface ReplaySource {
  applicationId: string;
  configVersionId: string;
  question: string;
  sourceTraceId: string;
  /** 原 trace 的答案与三分（有则并排左侧显示；来自质量面板/报告数据）。 */
  originalAnswer?: string;
  originalScores?: ReplayScores | null;
  originalVersionLabel?: string;
}

export interface SidePanelData {
  versionLabel: string;
  answer: string;
  scores?: ReplayScores | null;
  traceId?: string | null;
  durationMs?: number;
  tokens?: number;
}

const SCORE_LABELS: Array<[keyof ReplayScores, string]> = [
  ["faithfulness", "忠实度"],
  ["answerRelevancy", "相关性"],
  ["contextPrecision", "精确率"],
];

function ScoreRow({ scores }: { scores?: ReplayScores | null }) {
  if (!scores) return <Text type="secondary">未评</Text>;
  return (
    <Space size={12} wrap>
      {SCORE_LABELS.map(([key, label]) => (
        <span key={key} style={{ fontSize: 12 }}>
          {label} <b>{scores[key] === null ? "—" : scores[key]}</b>
        </span>
      ))}
    </Space>
  );
}

function deltaTag(a: number | null | undefined, b: number | null | undefined) {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  const d = b - a;
  if (d === 0) return <Tag>±0</Tag>;
  return <Tag color={d > 0 ? "green" : "red"}>{d > 0 ? `+${d}` : `${d}`}</Tag>;
}

/** F7/F8 共用：两侧答案 + 三分 + Δ 的并排视图（Task 13 屏4 复用）。 */
export function SideBySidePanel({ left, right }: { left: SidePanelData; right: SidePanelData }) {
  const card = (side: SidePanelData, title: string) => (
    <div
      style={{ flex: 1, border: "1px solid #f0f0f0", borderRadius: 8, padding: 12, minWidth: 0 }}
    >
      <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginBottom: 4 }}>
        {title} · {side.versionLabel}
      </div>
      <Paragraph style={{ fontSize: 13, marginBottom: 8, whiteSpace: "pre-wrap" }}>
        {side.answer || "—"}
      </Paragraph>
      <ScoreRow scores={side.scores} />
    </div>
  );
  return (
    <div>
      <Flex gap={12} align="stretch">
        {card(left, "原 trace")}
        {card(right, "重放")}
      </Flex>
      {/* Δ 指标条：忠实度/精确率/耗时/token 强制并排 */}
      <Flex gap={16} style={{ marginTop: 12, fontSize: 12 }} wrap>
        <span>
          忠实度 Δ {deltaTag(left.scores?.faithfulness, right.scores?.faithfulness) ?? "—"}
        </span>
        <span>
          精确率 Δ {deltaTag(left.scores?.contextPrecision, right.scores?.contextPrecision) ?? "—"}
        </span>
        <span>
          耗时{" "}
          {right.durationMs !== undefined ? `${right.durationMs}ms` : "—"}
        </span>
        <span>Token {right.tokens !== undefined ? right.tokens : "—"}</span>
      </Flex>
    </div>
  );
}

const WARNING =
  "⚠ LLM 非确定性：同配置重放结果也可能不同；产出为 preview trace，不入线上统计与问题池";

interface VersionOption {
  id: string;
  version: number;
}

export default function ReplayModal({
  open,
  source,
  onClose,
}: {
  open: boolean;
  source: ReplaySource | null;
  onClose: () => void;
}) {
  const [question, setQuestion] = useState("");
  const [versionId, setVersionId] = useState("");
  const [versions, setVersions] = useState<VersionOption[]>([]);
  const [origMissing, setOrigMissing] = useState(false);
  const [running, setRunning] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [scores, setScores] = useState<ReplayScores | null>(null);
  const [doneTraceId, setDoneTraceId] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [span, setSpan] = useState<TraceDetailResponse | null>(null);
  const [spanMissing, setSpanMissing] = useState(false);

  /**
   * 清空一次重放的全部产出态。打开弹窗与「再跑一次」共用——两处若各写一份，
   * 将来新增一个结果字段忘了同步，就会把上一次的结果漏进下一次的面板。
   */
  const resetResult = () => {
    setStreamText("");
    setScores(null);
    setDoneTraceId(null);
    setFinished(false);
    setErrorMsg(null);
    setSpan(null);
    setSpanMissing(false);
  };

  useEffect(() => {
    if (!open || !source) return;
    setQuestion(source.question);
    setVersionId(source.configVersionId);
    setVersions([]);
    setOrigMissing(false);
    setRunning(false);
    resetResult();
    void getApplicationDetail(source.applicationId)
      .then((detail) => {
        const list = (detail.versions ?? []).map((v) => ({ id: v.id, version: v.version }));
        setVersions(list);
        // 原版本不在列表/应用已删 → 置灰并默认切 production（§17.6/§19.1）。
        if (!list.some((v) => v.id === source.configVersionId)) {
          setOrigMissing(true);
          const prod = detail.productionConfigVersionId;
          if (prod) setVersionId(prod);
        }
      })
      .catch(() => setVersions([]));
  }, [open, source]);

  const versionLabel = useMemo(() => {
    const v = versions.find((x) => x.id === versionId);
    return v ? `v${v.version}` : source?.originalVersionLabel ?? "—";
  }, [versions, versionId, source]);

  if (!source) return null;

  const run = async () => {
    const trimmed = question.trim();
    if (!trimmed) {
      void message.error("问题不能为空");
      return;
    }
    setRunning(true);
    resetResult();
    try {
      for await (const ev of streamReplay({
        applicationId: source.applicationId,
        configVersionId: versionId,
        question: trimmed,
        sourceTraceId: source.sourceTraceId,
      })) {
        if (ev.type === "token") setStreamText((prev) => prev + ev.delta);
        else if (ev.type === "replay_scores") {
          setScores({
            faithfulness: ev.faithfulness,
            answerRelevancy: ev.answerRelevancy,
            contextPrecision: ev.contextPrecision,
          });
        } else if (ev.type === "done") setDoneTraceId(ev.traceId);
        else if (ev.type === "error") setErrorMsg(ev.message);
      }
      setFinished(true);
    } catch (err) {
      if (err instanceof ChatStreamError && err.status === 429) {
        void message.error("操作过于频繁，请 1 分钟后再试");
      } else if (err instanceof ChatStreamError && err.status === 422) {
        void message.error("该版本已不可用");
      } else {
        setErrorMsg((err as Error).message);
      }
    } finally {
      setRunning(false);
    }
  };

  const loadSpan = async (traceId: string) => {
    setSpanMissing(false);
    try {
      setSpan(await getTrace(traceId));
    } catch {
      // ClickHouse 落库有延迟 → 拉不到时提示稍后可在 Trace 列表查看。
      setSpanMissing(true);
    }
  };

  const showResult = running || finished || streamText.length > 0;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={showResult ? 820 : 560}
      title="重放这条问答"
      footer={
        showResult
          ? [
              <Button key="again" onClick={run} disabled={running}>
                再跑一次
              </Button>,
              <Button key="close" type="primary" onClick={onClose}>
                关闭
              </Button>,
            ]
          : [
              <Button key="cancel" onClick={onClose}>
                取消
              </Button>,
              <Button key="run" type="primary" loading={running} onClick={run}>
                运行
              </Button>,
            ]
      }
    >
      {!showResult && (
        <Space direction="vertical" style={{ width: "100%" }} size={12}>
          <div>
            <Text type="secondary">问题</Text>
            <Input.TextArea
              aria-label="重放问题"
              rows={3}
              maxLength={500}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </div>
          <div>
            <Text type="secondary">跑哪个配置</Text>
            <Flex gap={8} align="center">
              <Tag color="blue">原配置 {source.originalVersionLabel ?? "—"}（重现）</Tag>
              <Select
                aria-label="配置版本"
                style={{ minWidth: 160 }}
                value={versionId}
                onChange={setVersionId}
                options={versions.map((v) => ({
                  value: v.id,
                  label: `v${v.version}`,
                  disabled: origMissing && v.id === source.configVersionId,
                }))}
              />
            </Flex>
            {origMissing && (
              <Text type="warning" style={{ fontSize: 12 }}>
                原配置版本已不可用，已默认切换到 production
              </Text>
            )}
          </div>
          <Alert type="warning" showIcon={false} message={<Text style={{ fontSize: 12 }}>{WARNING}</Text>} />
        </Space>
      )}

      {showResult && (
        <div>
          {running && streamText.length === 0 && (
            <Flex align="center" gap={8} style={{ marginBottom: 12 }}>
              <Spin size="small" /> <Text type="secondary">重放中…</Text>
            </Flex>
          )}
          {!finished && streamText.length > 0 && (
            <Paragraph style={{ whiteSpace: "pre-wrap" }}>{streamText}</Paragraph>
          )}
          {errorMsg && <Alert type="error" message={`重放失败：${errorMsg} · 重试`} />}
          {finished && !errorMsg && (
            <>
              <SideBySidePanel
                left={{
                  versionLabel: source.originalVersionLabel ?? "原版本",
                  answer: source.originalAnswer ?? "—",
                  scores: source.originalScores ?? null,
                }}
                right={{
                  versionLabel,
                  answer: streamText,
                  scores,
                  traceId: doneTraceId,
                }}
              />
              <Tabs
                style={{ marginTop: 12 }}
                items={[
                  {
                    key: "spans",
                    label: "span 树",
                    children: doneTraceId ? (
                      span ? (
                        <div style={{ fontSize: 12 }}>
                          {span.spans.map((s) => (
                            <div key={s.spanId}>
                              {s.name} · {Math.round(s.durationMs)}ms
                            </div>
                          ))}
                        </div>
                      ) : spanMissing ? (
                        <Space>
                          <Text type="secondary">trace 正在入库，稍后可在 Trace 列表查看</Text>
                          <Button size="small" onClick={() => loadSpan(doneTraceId)}>
                            重试
                          </Button>
                        </Space>
                      ) : (
                        <Button size="small" onClick={() => loadSpan(doneTraceId)}>
                          加载 span 树
                        </Button>
                      )
                    ) : (
                      <Text type="secondary">—</Text>
                    ),
                  },
                ]}
              />
              {doneTraceId && (
                <div style={{ marginTop: 8 }}>
                  <Link to={`/admin/traces/${doneTraceId}`}>查看重放 trace →</Link>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
