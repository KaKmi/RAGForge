import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, Collapse, message, Segmented, Spin, Tooltip } from "antd";
import type {
  EvalCaseRef,
  TraceDetailResponse,
  TraceQualityDetail,
  TraceStatus,
} from "@codecrush/contracts";
import {
  createGapItem,
  getEvalCaseRefs,
  getTrace,
  getTraceQuality,
  scoreTraceNow,
} from "../../api/client";
import AddToEvalSetModal from "./AddToEvalSetModal";
import ReplayModal, { type ReplaySource } from "./ReplayModal";
import {
  autoSelectSpan,
  buildOtlpJson,
  buildSpanDetail,
  buildWaterfall,
  type ContractStep,
  KIND_LEGEND,
  rootSpanOf,
  rewrittenQueryOf,
  traceAlerts,
  traceSpanTotal,
} from "./traceDetail";

/** Trace 详情：meta + 时间轴/树 + 数据驱动 span 面板 + OTLP JSON。M9 W2 接真实读模型。 */

const STATUS_TAG: Record<TraceStatus, { label: string; bg: string; c: string; bd: string }> = {
  success: { label: "成功", bg: "#f6ffed", c: "#52c41a", bd: "#b7eb8f" },
  fallback: { label: "兜底", bg: "#fffbe6", c: "#d48806", bd: "#ffe58f" },
  failed: { label: "失败", bg: "#fff2f0", c: "#ff4d4f", bd: "#ffccc7" },
};
const fmtMs = (ms: number): string =>
  ms >= 1000 ? (ms / 1000).toFixed(2) + "s" : Math.round(ms) + "ms";

/** `CreateGapItemRequestSchema.question` 的上限（契约 `.max(500)`）。 */
const GAP_QUESTION_MAX = 500;

/**
 * 原型 §18.D：「面板『评分中』；轮询 5s×6」——两个数字都来自原型，不要随手调。
 *
 * ⚠️ 跨层契约：5s×6 = 30s 是「轮询到顶 → 显示重试按钮」的时刻。后端
 * `evaluations.service.ts` 的手动评测限频窗口（60s）曾整段盖住这里，导致重试第一次
 * 点击必撞 429；现已改为「限频只挡会新增裁判调用的请求」。若要动这两个常数或那个窗口，
 * 请一并核对两侧——它们是同一条时序契约的两端。
 */
const QUALITY_POLL_INTERVAL_MS = 5000;
const QUALITY_POLL_LIMIT = 6;

const fmtScore = (v: number | null): string =>
  v == null ? "—" : Number.isInteger(v) ? String(v) : v.toFixed(v >= 1 ? 1 : 3);

export default function TraceDetailPage() {
  const { traceId = "" } = useParams<{ traceId: string }>();
  const nav = useNavigate();
  const [data, setData] = useState<TraceDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [quality, setQuality] = useState<TraceQualityDetail | null>(null);
  const [qualityError, setQualityError] = useState(false);
  const [selSid, setSelSid] = useState<string | null>(null);
  const [view, setView] = useState<"timeline" | "tree">("timeline");
  const [jsonOpen, setJsonOpen] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  // B1/F2：这条 trace 已进过哪些评测集——决定按钮是「+ 加入评测集」还是「已在评测集 · 查看」。
  const [caseRefs, setCaseRefs] = useState<EvalCaseRef[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  /** B2a Task 8：「+ 加入问题池」进行中（防连点——重复提交会撞唯一索引，白跑一次往返）。 */
  const [pooling, setPooling] = useState(false);
  // B1/F3：「立即评测」入队中（防连点）与「轮询到顶仍无结果」。
  const [scoreBusy, setScoreBusy] = useState(false);
  const [pollTimedOut, setPollTimedOut] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setQuality(null);
    setQualityError(false);
    getTrace(traceId)
      .then((r) => {
        if (live) setData(r);
      })
      .catch((e: unknown) => {
        if (live) message.error(e instanceof Error ? e.message : "加载 Trace 详情失败");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    getTraceQuality(traceId)
      .then((result) => {
        if (live) setQuality(result);
      })
      .catch(() => {
        if (live) setQualityError(true);
      });
    // B1/F2：按钮两态的判据。取不到就当「未入集」——按钮显示「+ 加入评测集」，
    // 用户点了会走后端真实校验，不会因为这一次读失败而做错事。
    getEvalCaseRefs(traceId)
      .then((refs) => {
        if (live) setCaseRefs(refs);
      })
      .catch(() => {
        if (live) setCaseRefs([]);
      });
    return () => {
      live = false;
    };
  }, [traceId]);

  /**
   * B1/F3：评分中轮询（原型 §18.D「面板『评分中』；轮询 5s×6」）。
   *
   * 上限 6 次是原型钉死的：到顶仍是 `scoring` 就**本地**转失败态（原型「轮询超时 → failed」），
   * 而不是无限轮询——后者会在裁判卡死时把一个前台页面变成永久的定时打点器。
   * 计数放 ref：`quality` 每次轮询都换新对象，若把它放进 deps，interval 会被反复
   * 拆装、5s 永远重新计时，轮询实际上永远走不到第 6 次。
   */
  const pollCount = useRef(0);
  const isScoring = quality?.status === "scoring";

  useEffect(() => {
    if (!isScoring || pollTimedOut) return;
    pollCount.current = 0;
    let live = true;
    const timer = setInterval(() => {
      void (async () => {
        pollCount.current += 1;
        const reached = pollCount.current >= QUALITY_POLL_LIMIT;
        try {
          const result = await getTraceQuality(traceId);
          if (!live) return;
          setQuality(result);
          if (result.status === "scoring" && reached) setPollTimedOut(true);
        } catch {
          // 单次轮询失败不该把面板打成错误态——下一拍还会再试；到顶仍无结果自会转失败。
          if (live && reached) setPollTimedOut(true);
        }
      })();
    }, QUALITY_POLL_INTERVAL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [isScoring, pollTimedOut, traceId]);

  /**
   * B1/F3：手动触发单条评测（原型 §18.D「unscored --用户[立即评测]--> scoring」）。
   * 失败态的「重试」走同一条路径——重试就是再入一次队。
   */
  const triggerScore = async () => {
    setScoreBusy(true);
    try {
      const result = await scoreTraceNow(traceId);
      setPollTimedOut(false);
      if (result.status === "scored") {
        // 后端说早就评过了：直接重取，不进轮询——否则白等 5s 才显示一个现成的分数。
        setQuality(await getTraceQuality(traceId));
      } else {
        setQuality({ status: "scoring", startedAt: null });
      }
    } catch (e: unknown) {
      message.error(e instanceof Error ? e.message : "发起评测失败");
    } finally {
      setScoreBusy(false);
    }
  };

  /**
   * 入集成功后切按钮态（原型 §17.6「成功 toast + 按钮态切换」）。
   *
   * 先用已知的 setId 乐观置位，再后台核对：若只依赖重取，一次读失败就会让用户
   * 看着「已成功」的 toast、按钮却还写着「+ 加入评测集」，转头再点一次造出重复用例。
   */
  const markAddedTo = (setId: string) => {
    const optimistic: EvalCaseRef = { setId, setName: "", caseId: "" };
    setCaseRefs((prev) => (prev.some((r) => r.setId === setId) ? prev : [...prev, optimistic]));
    // 后台核对拿到权威数据；但**不允许它把刚加的这条抹掉**——重取失败或读到旧快照时
    // 若直接覆盖，用户会看着「已成功」的 toast、按钮却退回「+ 加入评测集」，转头再点一次造重复用例。
    void getEvalCaseRefs(traceId)
      .then((refs) =>
        setCaseRefs(refs.some((r) => r.setId === setId) ? refs : [...refs, optimistic]),
      )
      .catch(() => undefined);
  };

  const spans = useMemo(() => data?.spans ?? [], [data]);
  const root = useMemo(() => rootSpanOf(spans), [spans]);
  const effSid = useMemo(() => autoSelectSpan(spans, selSid), [spans, selSid]);
  const waterfall = useMemo(() => buildWaterfall(spans, effSid), [spans, effSid]);
  const total = useMemo(() => traceSpanTotal(spans), [spans]);
  const selSpan = useMemo(() => spans.find((s) => s.spanId === effSid), [spans, effSid]);
  const detail = useMemo(
    () => (selSpan && root ? buildSpanDetail(selSpan, root) : null),
    [selSpan, root],
  );
  const alerts = useMemo(() => traceAlerts(spans), [spans]);

  const copyJson = () => {
    if (!data) return;
    try {
      navigator.clipboard?.writeText(buildOtlpJson(data.traceId, data.meta, spans));
    } catch {
      /* ignore */
    }
    setJsonOpen(true);
  };

  /**
   * 「+ 加入问题池」（原型 `:388`，文案照 §19.2 `:753`）。
   *
   * `traceStartTime` **必须带上**：后端读不了 trace（`gaps → traces` 是禁止的边，021 决策 B
   * 规定走前端组合），而这一屏手里就有根 chain span 的 startTime——它正是
   * `codecrush_traces.start_time` 的定义。不带则该样本只进累计 `freq`、不进 `freq30d`，
   * 屏5 会把一条人刚断言「这是真实流量」的样本显示成「近30天 0」，读起来像陈旧流量。
   */
  const addToPool = async () => {
    if (!data) return;
    const question = data.meta.userInput.trim();
    /**
     * 本地先挡契约的长度上限。不挡的话 `client.ts` 的 `postJson` 会在**发请求前**同步抛
     * ZodError，而 `ZodError.message` 是一坨序列化的 issues 数组——用户在 toast 里看到
     * 一段 JSON，而这一屏又没有可编辑问题的输入框，等于死路。
     * 线上 `ChatRequestSchema.query` 没有长度上限，所以 600 字的真实提问是会出现的。
     * （同 `AddToEvalSetModal.tsx:89-99` 记过的同一个坑。）
     */
    if (question.length > GAP_QUESTION_MAX) {
      message.error(`问题超过 ${GAP_QUESTION_MAX} 字，无法直接加入问题池`);
      return;
    }
    // 未来时间会被后端 400（它只会给出一句面向开发的时区提示）。时钟偏移是真实存在的，
    // 与其把这种错误弹给管理员，不如干脆不带这个字段——代价只是该样本不进 30 天窗口。
    const startTime = rootSpanOf(spans)?.startTime;
    const usableStartTime =
      startTime && new Date(startTime).getTime() <= Date.now() ? startTime : undefined;
    setPooling(true);
    try {
      /**
       * ⛔ 改写结果**必须带上**（与 `traceStartTime` 同理：后端读不了 trace）。
       *
       * 不带的后果不是「少个字段」，是一串连锁故障（2026-07-21 真环境实测）：
       * 后端会退回保守默认 `rewriteResolved=false` ⇒ 该样本被误标「指代未消解」⇒
       * ① 评测臂强制人再改写一遍系统已经改写好的问题；
       * ② 聚类键退回原文（021 决策 F 被架空）⇒ 近义问题聚不到一起；
       * ③ 回验拿那句带指代的原话去重放 ⇒ 必然低分 ⇒ **假的「复发」标**。
       *
       * 超长则不带（契约上限 500）——宁可退回保守默认，也不要整个请求被 Zod 打回。
       */
      const rewritten = rewrittenQueryOf(spans);
      const usableRewritten =
        rewritten && rewritten.length <= GAP_QUESTION_MAX ? rewritten : undefined;
      const result = await createGapItem({
        question,
        source: "manual_trace",
        sourceTraceId: data.traceId,
        ...(usableStartTime ? { traceStartTime: usableStartTime } : {}),
        ...(usableRewritten ? { rewrittenQuestion: usableRewritten } : {}),
      });
      if (result.joinedExisting) {
        // 原型 `:648`：命中既有簇不是错误，是有用的信息——告诉他这问题已经被记了多少次，
        // 并给一条能点过去的路。用 info 而不是 error/warning。
        message.info({
          content: (
            <span>
              该问题已在缺口『{result.representativeQuestion}』(×{result.freq}) 中 ·{" "}
              <a onClick={() => nav("/admin/gaps")}>查看</a>
            </span>
          ),
        });
      } else {
        message.success("已加入问题池");
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "加入问题池失败");
    } finally {
      setPooling(false);
    }
  };

  const headBtn: CSSProperties = {
    height: 30,
    padding: "0 12px",
    border: "1px solid #d9d9d9",
    borderRadius: 6,
    background: "#fff",
    display: "flex",
    alignItems: "center",
    gap: 5,
    fontSize: 13,
    cursor: "pointer",
  };

  if (loading) {
    return (
      <div style={{ padding: 64, textAlign: "center" }}>
        <Spin />
      </div>
    );
  }
  if (!data || !root) {
    return (
      <div>
        <div
          onClick={() => nav("/admin/traces")}
          style={{ ...headBtn, width: "fit-content", marginBottom: 16 }}
        >
          ← 返回列表
        </div>
        <div style={{ padding: 48, textAlign: "center", color: "rgba(0,0,0,.3)", fontSize: 13 }}>
          未找到该 Trace（可能尚未落库或已过期）
        </div>
      </div>
    );
  }

  const meta = data.meta;
  const st = STATUS_TAG[meta.status];

  return (
    <div>
      {/* 头部：返回 + traceId + 状态 + 加入评测集 / 重放 / 跳 Prompt / 复制 JSON */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <div onClick={() => nav("/admin/traces")} style={headBtn}>
          ← 返回列表
        </div>
        <div style={{ fontSize: 16, fontWeight: 600, fontFamily: "ui-monospace,Menlo,monospace" }}>
          {data.traceId}
        </div>
        <span
          style={{
            fontSize: 12,
            lineHeight: "20px",
            padding: "0 8px",
            borderRadius: 4,
            background: st.bg,
            color: st.c,
            border: `1px solid ${st.bd}`,
          }}
        >
          {st.label}
        </span>
        <div style={{ flex: 1 }} />
        {/* 原型 §10 顶部操作组，顺序照 `:388`：加入评测集 → 加入问题池 → 重放 → 跳 Prompt → 复制。 */}
        {caseRefs.length > 0 ? (
          // 原型 §17.6 `:647`「已在集:按钮变「已在评测集·查看」」
          <Button onClick={() => nav("/admin/eval/sets")}>已在评测集 · 查看</Button>
        ) : (
          // 问题为空的 trace 入不了集（用例的 question 契约要求非空）。与其让用户
          // 点完在弹窗里撞一堵墙，不如在这里就说明白——同「重放」缺 agentId 的处理方式。
          <Tooltip title={meta.userInput?.trim() ? "" : "trace 缺少用户问题，无法加入评测集"}>
            <span>
              <Button disabled={!meta.userInput?.trim()} onClick={() => setAddOpen(true)}>
                + 加入评测集
              </Button>
            </span>
          </Tooltip>
        )}
        {/*
          021 决策 B：入池入口在**前端组合**——这一屏调 `POST /api/gaps/items`，
          后端不会出现 `traces → gaps` 或 `eval-runs → gaps` 的反向边（eslint Boundary ⑤ 机械拦）。
        */}
        <Tooltip title={meta.userInput?.trim() ? "" : "trace 缺少用户问题，无法加入问题池"}>
          <span>
            <Button
              disabled={!meta.userInput?.trim() || pooling}
              loading={pooling}
              onClick={addToPool}
            >
              + 加入问题池
            </Button>
          </span>
        </Tooltip>
        <Tooltip title={meta.agentId ? "" : "trace 缺少应用信息，无法重放"}>
          <Button type="primary" ghost disabled={!meta.agentId} onClick={() => setReplayOpen(true)}>
            ↻ 重放
          </Button>
        </Tooltip>
        <div onClick={() => nav("/admin/prompts")} style={headBtn}>
          跳转 Prompt 版本 →
        </div>
        <div onClick={copyJson} style={headBtn}>
          {"{ }"} 复制 JSON
        </div>
      </div>

      <AddToEvalSetModal
        open={addOpen}
        sourceTraceId={traceId}
        question={meta.userInput ?? ""}
        onClose={() => setAddOpen(false)}
        onDone={(setId) => {
          setAddOpen(false);
          markAddedTo(setId);
        }}
      />

      <ReplayModal
        open={replayOpen}
        source={
          meta.agentId
            ? ({
                applicationId: meta.agentId,
                configVersionId: meta.promptVersionId ?? "",
                question: meta.userInput,
                sourceTraceId: data.traceId,
                originalVersionLabel: meta.promptVersionId ? "原版本" : undefined,
              } satisfies ReplaySource)
            : null
        }
        onClose={() => setReplayOpen(false)}
      />

      {/* meta 卡 */}
      <div
        style={{
          background: "#fff",
          border: "1px solid #f0f0f0",
          borderRadius: 8,
          padding: "16px 20px",
          marginBottom: 16,
        }}
      >
        <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginBottom: 4 }}>用户问题</div>
        <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 14 }}>
          {meta.userInput || "—"}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 14 }}>
          <MetaCell label="应用" value={meta.agentName ?? "—"} />
          <MetaCell
            label="生成模型"
            value={meta.genModel ?? "—"}
            sub={meta.genModelVersion ?? undefined}
          />
          <MetaCell label="总耗时" value={fmtMs(meta.durationMs)} bold />
          <MetaCell
            label="Tokens"
            value={(meta.inputTokens + meta.outputTokens).toLocaleString()}
            sub={`入 ${meta.inputTokens} / 出 ${meta.outputTokens}`}
          />
          <MetaCell
            label="Cost"
            value={meta.cost == null ? "—" : "¥" + meta.cost.toFixed(4)}
            bold
            color="#1677ff"
          />
        </div>
      </div>

      <div
        style={{
          background: "#fff",
          border: "1px solid #f0f0f0",
          borderRadius: 8,
          padding: "16px 20px",
          marginBottom: 16,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>答案质量</div>
        {qualityError && <div style={{ color: "#d48806" }}>质量数据暂不可用</div>}
        {!qualityError && !quality && <Spin size="small" />}
        {quality?.status === "unscored" && (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ color: "rgba(0,0,0,.45)" }}>未抽样评测</span>
            <Button size="small" loading={scoreBusy} onClick={() => void triggerScore()}>
              立即评测
            </Button>
          </div>
        )}
        {/* 评分中：轮询未到顶。到顶仍无结果按原型转失败态，走下面那个分支。 */}
        {quality?.status === "scoring" && !pollTimedOut && (
          <div style={{ color: "#1677ff" }}>● 裁判评分中…（约 30s）</div>
        )}
        {(quality?.status === "failed" || (quality?.status === "scoring" && pollTimedOut)) && (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ color: "#d46b08" }}>裁判调用失败</span>
            {quality.status === "failed" && (
              <span style={{ color: "rgba(0,0,0,.45)", fontSize: 12 }}>{quality.reason}</span>
            )}
            <Button size="small" loading={scoreBusy} onClick={() => void triggerScore()}>
              重试
            </Button>
          </div>
        )}
        {quality?.status === "scored" && (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, minmax(120px, 1fr))",
                gap: 12,
                marginBottom: 12,
              }}
            >
              {(
                [
                  ["事实一致性", "faithfulness"],
                  ["答案相关性", "answerRelevancy"],
                  ["上下文精度", "contextPrecision"],
                ] as const
              ).map(([label, metric]) => {
                const value = quality.scores[metric];
                const unscored = value === null;
                const low = !unscored && value < quality.thresholds[metric];
                return (
                  <div
                    key={metric}
                    data-testid={`quality-score-${metric}`}
                    data-quality-state={unscored ? "unscored" : low ? "low" : "pass"}
                    style={{
                      padding: 12,
                      borderRadius: 6,
                      background: unscored ? "#fafafa" : low ? "#fff2f0" : "#f6ffed",
                    }}
                  >
                    <div style={{ color: "rgba(0,0,0,.45)", fontSize: 12 }}>{label}</div>
                    <div
                      style={{
                        color: unscored ? "rgba(0,0,0,.45)" : low ? "#cf1322" : "#389e0d",
                        fontSize: 22,
                        fontWeight: 700,
                      }}
                    >
                      {value ?? "未评"}
                    </div>
                    <div style={{ color: "rgba(0,0,0,.35)", fontSize: 11 }}>
                      阈值 {quality.thresholds[metric]}
                    </div>
                  </div>
                );
              })}
            </div>
            <Collapse
              size="small"
              items={[
                {
                  key: "evidence",
                  label: `评测依据 · ${quality.judgeVersion}`,
                  children: (
                    <div>
                      {Object.entries(quality.evidence).map(([metric, items]) => (
                        <div key={metric} style={{ marginBottom: 8 }}>
                          <strong>{metric}</strong>
                          <ul>
                            {items.map((item) => (
                              <li key={item}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  ),
                },
              ]}
            />
          </>
        )}
      </div>

      {/* #4 降级/异常置顶：任一节点报错/降级，顶部汇总一条，点击直达对应节点，不用逐个点 */}
      {alerts.length > 0 && (
        <div style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          {alerts.map((al) => (
            <div
              key={al.sid}
              onClick={() => setSelSid(al.sid)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 14px",
                borderRadius: 6,
                cursor: "pointer",
                background: al.tone === "err" ? "#fff2f0" : "#fffbe6",
                border: `1px solid ${al.tone === "err" ? "#ffccc7" : "#ffe58f"}`,
              }}
            >
              <span style={{ fontSize: 14, color: al.tone === "err" ? "#ff4d4f" : "#d48806" }}>
                {al.tone === "err" ? "✕" : "⚠"}
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, color: "rgba(0,0,0,.75)" }}>
                {al.name}
              </span>
              <span
                style={{
                  fontSize: 13,
                  color: "rgba(0,0,0,.55)",
                  flex: 1,
                  minWidth: 0,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {al.msg}
              </span>
              <span
                style={{
                  fontSize: 12,
                  color: al.tone === "err" ? "#ff4d4f" : "#d48806",
                  flex: "none",
                }}
              >
                定位 →
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 两栏：左调用链 + 右 span 面板 */}
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <div
          data-testid="trace-call-chain"
          style={{
            width: "34vw",
            minWidth: 560,
            maxWidth: 680,
            flex: "none",
            background: "#fff",
            border: "1px solid #f0f0f0",
            borderRadius: 8,
            padding: "12px 10px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0 6px 10px",
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600 }}>调用链</div>
            <Segmented
              size="small"
              value={view}
              onChange={(v) => setView(v as "timeline" | "tree")}
              options={[
                { label: "时间轴", value: "timeline" },
                { label: "树", value: "tree" },
              ]}
            />
          </div>

          {/* TRACE 根行 */}
          <div
            onClick={() => setSelSid(root.spanId)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              height: 32,
              padding: "0 6px",
              borderRadius: 5,
              cursor: "pointer",
              background: effSid === root.spanId ? "#e6f4ff" : "transparent",
              marginBottom: 2,
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: ".5px",
                color: "#1677ff",
                background: "#f0f5ff",
                border: "1px solid #d6e4ff",
                borderRadius: 4,
                padding: "1px 6px",
              }}
            >
              TRACE
            </span>
            <span
              style={{
                fontSize: 12,
                color: "rgba(0,0,0,.55)",
                flex: 1,
                minWidth: 0,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {meta.userInput}
            </span>
            <span style={{ fontSize: 11, color: "rgba(0,0,0,.4)", flex: "none" }}>
              {fmtMs(meta.durationMs)}
            </span>
          </div>

          {view === "timeline" && (
            <>
              <div
                style={{
                  position: "relative",
                  height: 16,
                  marginLeft: 184,
                  marginRight: 92,
                  marginBottom: 4,
                  borderBottom: "1px solid #f0f0f0",
                }}
              >
                {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                  <span
                    key={f}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: f * 100 + "%",
                      transform: "translateX(-50%)",
                      fontSize: 9.5,
                      color: "rgba(0,0,0,.35)",
                    }}
                  >
                    {fmtMs(Math.round(total * f))}
                  </span>
                ))}
              </div>
              {waterfall.map((s) => (
                <div
                  key={s.sid}
                  onClick={() => setSelSid(s.sid)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "184px minmax(0, 1fr) 92px",
                    alignItems: "center",
                    height: 32,
                    borderRadius: 5,
                    cursor: "pointer",
                    background: s.sel ? "#e6f4ff" : "transparent",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      paddingLeft: s.indent + 6,
                      paddingRight: 8,
                      minWidth: 0,
                      boxSizing: "border-box",
                      position: "relative",
                    }}
                  >
                    {s.indent > 0 && (
                      <span
                        aria-hidden="true"
                        style={{
                          position: "absolute",
                          left: s.indent - 8,
                          top: 0,
                          width: 12,
                          height: 16,
                          borderLeft: "1px solid #d9d9d9",
                          borderBottom: "1px solid #d9d9d9",
                          borderBottomLeftRadius: 4,
                        }}
                      />
                    )}
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        flex: "none",
                        borderRadius: 2,
                        background: s.kindC,
                      }}
                    />
                    <span
                      style={{
                        fontSize: 12,
                        color: s.isErr ? "#ff4d4f" : "rgba(0,0,0,.85)",
                        fontWeight: s.sel ? 600 : 400,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {s.name}
                    </span>
                  </div>
                  <div style={{ flex: 1, position: "relative", height: "100%", minWidth: 0 }}>
                    <div
                      style={{
                        position: "absolute",
                        top: 8,
                        height: 14,
                        left: s.leftPct,
                        width: s.widthPct,
                        background: s.isErr ? "#ff4d4f" : s.isFallback ? "#faad14" : s.kindC,
                        opacity: s.isSkip ? 0.35 : s.sel ? 1 : 0.85,
                        borderRadius: 3,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {s.isErr && (
                        <span style={{ fontSize: 10, color: "#fff", fontWeight: 700 }}>✕</span>
                      )}
                      {!s.isErr && s.isFallback && (
                        <span style={{ fontSize: 10, color: "#fff", fontWeight: 700 }}>⚠</span>
                      )}
                    </div>
                  </div>
                  <span
                    style={{
                      paddingRight: 6,
                      fontSize: 10.5,
                      color: "rgba(0,0,0,.45)",
                      textAlign: "right",
                      whiteSpace: "nowrap",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {s.isSkip ? "未执行" : `${fmtMs(s.durationMs)} · ${s.pctOfTotal}%`}
                  </span>
                </div>
              ))}
              <div
                style={{
                  display: "flex",
                  gap: 12,
                  flexWrap: "wrap",
                  padding: "10px 6px 0",
                  borderTop: "1px solid #f5f5f5",
                  marginTop: 8,
                }}
              >
                {KIND_LEGEND.map((k) => (
                  <div key={k.label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: k.c }} />
                    <span style={{ fontSize: 10.5, color: "rgba(0,0,0,.5)" }}>{k.label}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {view === "tree" && (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {waterfall.map((s) => (
                <div
                  key={s.sid}
                  onClick={() => setSelSid(s.sid)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    height: 32,
                    padding: "0 6px",
                    borderRadius: 5,
                    cursor: "pointer",
                    background: s.sel ? "#e6f4ff" : "transparent",
                  }}
                >
                  <div style={{ width: s.indent, flex: "none" }} />
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      flex: "none",
                      borderRadius: 2,
                      background: s.kindC,
                    }}
                  />
                  <span
                    style={{
                      fontSize: 12.5,
                      color: s.isErr ? "#ff4d4f" : "rgba(0,0,0,.85)",
                      fontWeight: s.sel ? 600 : 400,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {s.name}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      color: s.kindC,
                      border: `1px solid ${s.kindC}`,
                      borderRadius: 3,
                      padding: "0 4px",
                      lineHeight: "14px",
                      flex: "none",
                      opacity: 0.75,
                    }}
                  >
                    {s.kindLabel}
                  </span>
                  {s.isFallback && (
                    <span
                      style={{
                        fontSize: 10,
                        color: "#d48806",
                        border: "1px solid #ffe58f",
                        background: "#fffbe6",
                        borderRadius: 3,
                        padding: "0 4px",
                        lineHeight: "14px",
                        flex: "none",
                      }}
                    >
                      降级
                    </span>
                  )}
                  <div style={{ flex: 1 }} />
                  <span
                    style={{
                      fontSize: 11,
                      color: "rgba(0,0,0,.4)",
                      flex: "none",
                      width: 90,
                      textAlign: "right",
                    }}
                  >
                    {s.isSkip ? "未执行" : `${fmtMs(s.durationMs)} · ${s.pctOfTotal}%`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 右栏 span 面板 */}
        {detail && (
          <div
            style={{
              flex: 1,
              minWidth: 0,
              background: "#fff",
              border: "1px solid #f0f0f0",
              borderRadius: 8,
              padding: "18px 22px",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 14,
                flexWrap: "wrap",
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 600 }}>{detail.title}</div>
              <span
                style={{
                  fontSize: 11,
                  lineHeight: "20px",
                  padding: "0 8px",
                  borderRadius: 4,
                  background: "#f5f5f5",
                  color: "rgba(0,0,0,.5)",
                  border: "1px solid #e8e8e8",
                }}
              >
                {detail.kindLabel}
              </span>
              <span
                style={{
                  fontSize: 12,
                  lineHeight: "20px",
                  padding: "0 8px",
                  borderRadius: 4,
                  background: detail.isErr ? "#fff2f0" : "#f6ffed",
                  color: detail.isErr ? "#ff4d4f" : "#52c41a",
                  border: `1px solid ${detail.isErr ? "#ffccc7" : "#b7eb8f"}`,
                }}
              >
                {detail.statusLabel}
              </span>
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 12, color: "rgba(0,0,0,.5)" }}>
                耗时 {fmtMs(detail.durationMs)} · 占总时长 {detail.durationPct}%
              </span>
              {detail.tokens && (
                <span style={{ fontSize: 12, color: "rgba(0,0,0,.5)" }}>
                  Tokens {detail.tokens}
                </span>
              )}
            </div>

            {detail.isErr && (
              <div
                style={{
                  background: "#fff2f0",
                  border: "1px solid #ffccc7",
                  borderRadius: 6,
                  padding: "12px 14px",
                  marginBottom: 16,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: "#ff4d4f", marginBottom: 4 }}>
                  ⚠ {detail.errType}
                </div>
                <div style={{ fontSize: 13, color: "rgba(0,0,0,.7)", lineHeight: 1.7 }}>
                  {detail.errMsg}
                </div>
              </div>
            )}

            {/* #1 NodeContract 校验链（我们独有）：结构化输出→校验→修复→降级，一眼看到「为什么兜底」 */}
            {detail.contractChain.length > 0 && (
              <>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "rgba(0,0,0,.45)",
                    marginBottom: 8,
                  }}
                >
                  NodeContract 校验链
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 2,
                    marginBottom: 16,
                  }}
                >
                  {detail.contractChain.map((step, i) => (
                    <ContractPill
                      key={i}
                      step={step}
                      last={i === detail.contractChain.length - 1}
                    />
                  ))}
                </div>
              </>
            )}

            {/* #2 意图→KB 路由高亮：意图节点直接显「路由到 售后库 / 订单FAQ」，解释后面召回为何命中/落空 */}
            {detail.routing && (
              <div
                style={{
                  background: "#f0f7ff",
                  border: "1px solid #d6e8ff",
                  borderRadius: 6,
                  padding: "12px 14px",
                  marginBottom: 16,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, color: "rgba(0,0,0,.45)" }}>识别意图</span>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: "#1677ff",
                      fontFamily: "ui-monospace,Menlo,monospace",
                    }}
                  >
                    {detail.routing.intent}
                  </span>
                  <span style={{ color: "rgba(0,0,0,.35)", fontSize: 12 }}>→ 路由到</span>
                  {detail.routing.kbNames.length > 0 ? (
                    detail.routing.kbNames.map((kb) => (
                      <span
                        key={kb}
                        style={{
                          fontSize: 12,
                          lineHeight: "20px",
                          padding: "0 8px",
                          borderRadius: 4,
                          background: "#e6f4ff",
                          color: "#1677ff",
                          border: "1px solid #91caff",
                        }}
                      >
                        {kb}
                      </span>
                    ))
                  ) : (
                    <span style={{ fontSize: 12, color: "rgba(0,0,0,.45)" }}>
                      不检索（闲聊/未命中路由）
                    </span>
                  )}
                </div>
              </div>
            )}

            {detail.meta.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
                {detail.meta.map((mt) => (
                  <div key={mt.k} style={{ display: "flex", gap: 12, fontSize: 13 }}>
                    <div style={{ width: 80, flex: "none", color: "rgba(0,0,0,.45)" }}>{mt.k}</div>
                    <div
                      style={{
                        color:
                          mt.tone === "err"
                            ? "#ff4d4f"
                            : mt.tone === "warn"
                              ? "#d48806"
                              : "rgba(0,0,0,.75)",
                        fontWeight: mt.tone ? 600 : 400,
                      }}
                    >
                      {mt.v}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {detail.scores.length > 0 && (
              <>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "rgba(0,0,0,.45)",
                    marginBottom: 6,
                  }}
                >
                  检索命中分表
                </div>
                <div
                  style={{
                    border: "1px solid #f0f0f0",
                    borderRadius: 6,
                    overflow: "hidden",
                    marginBottom: 16,
                  }}
                >
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 76px 84px 82px 70px",
                      padding: "8px 14px",
                      background: "#fafafa",
                      borderBottom: "1px solid #f0f0f0",
                      fontSize: 12,
                      fontWeight: 600,
                      color: "rgba(0,0,0,.55)",
                    }}
                  >
                    <div>命中分块</div>
                    <div style={{ textAlign: "right" }}>向量分</div>
                    <div style={{ textAlign: "right" }}>关键词分</div>
                    <div style={{ textAlign: "right" }}>Rerank</div>
                    <div style={{ textAlign: "right" }}>结果</div>
                  </div>
                  {detail.scores.map((sc, i) => (
                    <div
                      key={i}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 76px 84px 82px 70px",
                        padding: "9px 14px",
                        borderBottom: "1px solid #f5f5f5",
                        fontSize: 12,
                        alignItems: "center",
                      }}
                    >
                      <div
                        style={{
                          color: "rgba(0,0,0,.7)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          paddingRight: 8,
                        }}
                      >
                        {sc.doc}
                      </div>
                      <div
                        style={{
                          textAlign: "right",
                          fontFamily: "ui-monospace,Menlo,monospace",
                          color: "rgba(0,0,0,.6)",
                        }}
                      >
                        {fmtScore(sc.vec)}
                      </div>
                      <div
                        style={{
                          textAlign: "right",
                          fontFamily: "ui-monospace,Menlo,monospace",
                          color: "rgba(0,0,0,.6)",
                        }}
                      >
                        {fmtScore(sc.kw)}
                      </div>
                      <div
                        style={{
                          textAlign: "right",
                          fontFamily: "ui-monospace,Menlo,monospace",
                          fontWeight: 600,
                          color: sc.pass ? "#52c41a" : "#ff4d4f",
                        }}
                      >
                        {fmtScore(sc.rr)}
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <span
                          style={{
                            fontSize: 11,
                            lineHeight: "18px",
                            padding: "0 6px",
                            borderRadius: 9,
                            background: sc.pass ? "#f6ffed" : "#fff2f0",
                            color: sc.pass ? "#52c41a" : "#ff4d4f",
                            border: `1px solid ${sc.pass ? "#b7eb8f" : "#ffccc7"}`,
                          }}
                        >
                          {sc.pass ? "命中" : "已过滤"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {detail.cites.length > 0 && (
              <>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "rgba(0,0,0,.45)",
                    marginBottom: 6,
                  }}
                >
                  引用来源 · 角标 ↔ 命中分块
                </div>
                <div
                  style={{
                    border: "1px solid #f0f0f0",
                    borderRadius: 6,
                    overflow: "hidden",
                    marginBottom: 16,
                  }}
                >
                  {detail.cites.map((c) => (
                    <div
                      key={c.n}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "9px 14px",
                        borderBottom: "1px solid #f5f5f5",
                      }}
                    >
                      <span
                        style={{
                          fontSize: 12,
                          fontFamily: "ui-monospace,Menlo,monospace",
                          fontWeight: 700,
                          color: "#1677ff",
                          flex: "none",
                        }}
                      >
                        [{c.n}]
                      </span>
                      <span
                        style={{
                          fontSize: 13,
                          color: "rgba(0,0,0,.75)",
                          flex: 1,
                          minWidth: 0,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {c.doc}
                      </span>
                      <span
                        style={{
                          fontSize: 11,
                          fontFamily: "ui-monospace,Menlo,monospace",
                          color: "#52c41a",
                          flex: "none",
                        }}
                      >
                        Rerank {c.score.toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {detail.isRoot ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "rgba(0,0,0,.45)" }}>
                    输入
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      lineHeight: "18px",
                      padding: "0 7px",
                      borderRadius: 9,
                      background: "#f6ffed",
                      color: "#52c41a",
                      border: "1px solid #b7eb8f",
                    }}
                  >
                    已脱敏
                  </span>
                </div>
                <div
                  style={{
                    background: "#fafafa",
                    border: "1px solid #f0f0f0",
                    borderRadius: 6,
                    padding: "12px 14px",
                    fontSize: 13,
                    lineHeight: 1.9,
                    whiteSpace: "pre-wrap",
                    marginBottom: 14,
                  }}
                >
                  {detail.input || "—"}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "rgba(0,0,0,.45)",
                    marginBottom: 6,
                  }}
                >
                  输出
                </div>
                <div
                  style={{
                    background: "#f0f7ff",
                    border: "1px solid #d6e8ff",
                    borderRadius: 6,
                    padding: "12px 14px",
                    fontSize: 13,
                    lineHeight: 1.9,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {detail.output || "—"}
                </div>
              </>
            ) : detail.rewrittenQuery ? (
              /*
                「问题改写」节点的输出。它一直埋在 `rag.rewrite.query` 里，但此前没被提取，
                于是这一屏显示「该节点无独立输入/输出记录」——而它恰恰是整条链路里最该看的
                一个中间产物：**下游检索用的是它，不是用户原话**。看不到它，排查
                「为什么召回不对」时就少了最关键的一环。
              */
              <>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "rgba(0,0,0,.45)",
                    marginBottom: 6,
                  }}
                >
                  改写后的问题
                </div>
                <div
                  style={{
                    background: "#f0f7ff",
                    border: "1px solid #d6e8ff",
                    borderRadius: 6,
                    padding: "12px 14px",
                    fontSize: 13,
                    lineHeight: 1.9,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {detail.rewrittenQuery}
                </div>
                <div style={{ fontSize: 12, color: "rgba(0,0,0,.35)", marginTop: 8 }}>
                  下游检索用的是这句，不是用户原话
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12, color: "rgba(0,0,0,.35)" }}>
                该节点无独立输入/输出记录（仅根节点保留脱敏 IO）
              </div>
            )}
          </div>
        )}
      </div>

      {jsonOpen && (
        <>
          <div
            onClick={() => setJsonOpen(false)}
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 60 }}
          />
          <div
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%,-50%)",
              width: 640,
              maxHeight: "78vh",
              background: "#fff",
              zIndex: 61,
              borderRadius: 10,
              display: "flex",
              flexDirection: "column",
              boxShadow: "0 8px 32px rgba(0,0,0,.2)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: 52,
                flex: "none",
                borderBottom: "1px solid #f0f0f0",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0 20px",
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 600 }}>OTLP Span JSON · {data.traceId}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 12, color: "#52c41a" }}>✓ 已复制到剪贴板</span>
                <div
                  onClick={() => setJsonOpen(false)}
                  style={{
                    fontSize: 18,
                    color: "rgba(0,0,0,.45)",
                    cursor: "pointer",
                    width: 28,
                    height: 28,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 4,
                  }}
                >
                  ×
                </div>
              </div>
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: "16px 20px", background: "#1e1e1e" }}>
              <pre
                style={{
                  margin: 0,
                  fontFamily: "ui-monospace,Menlo,monospace",
                  fontSize: 12,
                  lineHeight: 1.7,
                  color: "#d4d4d4",
                  whiteSpace: "pre-wrap",
                }}
              >
                {buildOtlpJson(data.traceId, data.meta, spans)}
              </pre>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ContractPill({ step, last }: { step: ContractStep; last: boolean }) {
  const tone =
    step.status === "err"
      ? { bg: "#fff2f0", c: "#ff4d4f", bd: "#ffccc7" }
      : step.status === "warn"
        ? { bg: "#fffbe6", c: "#d48806", bd: "#ffe58f" }
        : { bg: "#f6ffed", c: "#52c41a", bd: "#b7eb8f" };
  return (
    <>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          fontSize: 12,
          lineHeight: "22px",
          padding: "0 10px",
          borderRadius: 12,
          background: tone.bg,
          color: tone.c,
          border: `1px solid ${tone.bd}`,
        }}
      >
        {step.label}
        {step.detail && (
          <code style={{ fontSize: 11, fontFamily: "ui-monospace,Menlo,monospace", opacity: 0.85 }}>
            {step.detail}
          </code>
        )}
      </span>
      {!last && <span style={{ color: "rgba(0,0,0,.25)", fontSize: 12, padding: "0 4px" }}>→</span>}
    </>
  );
}

function MetaCell({
  label,
  value,
  sub,
  mono,
  bold,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  mono?: boolean;
  bold?: boolean;
  color?: string;
}) {
  return (
    <div>
      <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginBottom: 3 }}>{label}</div>
      <div
        style={{
          fontSize: 13,
          fontWeight: bold ? 500 : 400,
          color,
          fontFamily: mono ? "ui-monospace,Menlo,monospace" : undefined,
        }}
      >
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: "rgba(0,0,0,.35)" }}>{sub}</div>}
    </div>
  );
}
