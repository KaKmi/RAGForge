import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Spin, message as antdMessage } from "antd";
import type {
  ApplicationDetail,
  ChatStreamEvent,
  Conversation,
  Message,
} from "@codecrush/contracts";
import {
  getApplications,
  getApplicationDetail,
  getConversations,
  getKnowledgeBases,
  getMessages,
} from "../../api/client";
import { ChatStreamError, openChatStream } from "../../api/sse";
import { MessageMarkdown } from "./message-markdown";

/** C 端问答页（M8 T4）：1:1 还原原型三栏（单 Agent 信息卡 + 会话历史 / 消息流 / 引用原文）。
 * 真接后端：进页 getApplications 取元信息（未上线→占位）；send 走 openChatStream 逐 token 流；
 * 行内 [n] 角标 ⇄ 右栏命中原文（citation.text）；可信度/引用完整度/兜底来自 done 事件。
 * 仅 production 正式态寻址（:agentId = slug 或 applicationId）。 */

const AGENT_COLOR = "#1677ff"; // 原型 botCard.color 无真实字段，固定主题色
const COPIED_RESET_MS = 1600;

const initialOf = (name: string) => name.trim().slice(0, 1).toUpperCase() || "A";

// 兜底原因 enum → 展示文案（013 §6 四原因 + 014 chitchat）
const FALLBACK_REASON_LABEL: Record<string, { k: string; v: string }> = {
  out_of_scope: { k: "超出范围", v: "问题不属于该 Agent 已接入的知识库主题" },
  low_similarity: { k: "相似度过低", v: "检索最高相似度低于命中阈值" },
  empty_retrieval: { k: "检索为空", v: "知识库中未检索到相关内容" },
  chitchat: { k: "闲聊问题", v: "非知识型问题，走通用兜底回复" },
  handled_by_fallback: { k: "已处理", v: "按「兜底话术」策略回复，未编造知识库外内容" },
};

interface CiteView {
  n: number;
  doc: string;
  kb: string;
  section: string;
  score: number;
  text?: string;
}

interface MsgView {
  key: string;
  role: "user" | "assistant";
  text: string; // 含行内 [n] 标记的原文
  citations: CiteView[]; // 实时流带 text；历史仅序号 → 空数组（右栏详情不可回放）
  confidence?: number;
  coverage?: "full" | "partial";
  isFallback: boolean;
  fallbackReasons: string[];
  streaming: boolean;
  errored?: string;
}

interface AgentMeta {
  applicationId: string;
  name: string;
  description: string;
  published: boolean;
  kbNames: string[];
}

function levelOf(conf: number) {
  if (conf >= 0.85) return { l: "高", c: "#52c41a", bg: "#f6ffed", bd: "#b7eb8f" };
  if (conf >= 0.7) return { l: "中", c: "#d48806", bg: "#fffbe6", bd: "#ffe58f" };
  return { l: "低", c: "#ff4d4f", bg: "#fff2f0", bd: "#ffccc7" };
}

/** 生产版本 kbIds（applications.ts:46,58 — ApplicationConfigVersion 携带 kbIds）。 */
function extractProductionKbIds(detail: ApplicationDetail): string[] {
  const prod = detail.versions.find((v) => v.id === detail.productionConfigVersionId);
  return prod?.kbIds ?? [];
}

/** 历史消息 → 视图。降级：历史 citations 仅存 [n] 序号（后端未落完整对象），
 * 故 citations 置空——历史 [n] 角标渲染但右栏无详情（spec G5）。 */
function historyToView(m: Message): MsgView {
  return {
    key: m.id,
    role: m.role,
    text: m.content,
    citations: [],
    confidence: m.confidence,
    coverage: m.coverage,
    isFallback: m.isFallback ?? false,
    fallbackReasons: m.fallbackInfo?.reasons ?? [],
    streaming: false,
  };
}

/** 复制用纯文本：去掉行内 [n] 标记。 */
const plainText = (t: string) => t.replace(/\[\d+\]/g, "");

/** 回复是否真的引用了检索知识：正文含至少一个 [n] 且 n 命中本条 citation。
 * 只有「检索过并在回复里真的引用」才展示可信度/引用完整度（闲聊/无据拒答不展示）。 */
function isCited(m: MsgView): boolean {
  if (m.citations.length === 0) return false;
  const ns = new Set([...m.text.matchAll(/\[(\d+)\]/g)].map((x) => Number(x[1])));
  return m.citations.some((c) => ns.has(c.n));
}

export default function ChatPage() {
  const { agentId = "" } = useParams();
  const navigate = useNavigate();

  const [meta, setMeta] = useState<AgentMeta | null>(null);
  const [metaLoading, setMetaLoading] = useState(true);
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [convId, setConvId] = useState<string | undefined>(undefined); // undefined = 新会话空态
  const [msgs, setMsgs] = useState<MsgView[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [rightOpen, setRightOpen] = useState(true);
  const [citeSel, setCiteSel] = useState<{ msgKey: string; n: number } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, "up" | "down">>({});

  const abortRef = useRef<AbortController | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 进页加载应用元信息（未上线判定 + 头部/信息卡 + KB 名标签）
  useEffect(() => {
    let alive = true;
    // agent 切换（Router 复用本组件，不卸载）：取消上一 agent 进行中的流，
    // 否则其 done 回调会把上一 agent 的会话列表/convId 污染到新 agent 页（peer review Finding 1）。
    abortRef.current?.abort();
    abortRef.current = null;
    setMetaLoading(true);
    setMsgs([]);
    setConvId(undefined);
    setCiteSel(null);
    (async () => {
      try {
        const apps = await getApplications();
        const app = apps.find((a) => a.slug === agentId || a.id === agentId);
        if (!app) {
          if (alive) {
            setMeta(null);
            setMetaLoading(false);
          }
          return;
        }
        const published = app.productionConfigVersionId != null;
        let kbNames: string[] = [];
        if (published) {
          try {
            const detail = await getApplicationDetail(app.id);
            const kbIds = extractProductionKbIds(detail);
            if (kbIds.length) {
              const kbs = await getKnowledgeBases();
              const byId = new Map(kbs.map((k) => [k.id, k.name]));
              kbNames = kbIds.map((id) => byId.get(id) ?? "").filter(Boolean);
            }
          } catch {
            // KB 名降级为空，不阻塞主流程
          }
        }
        if (alive) {
          setMeta({
            applicationId: app.id,
            name: app.name,
            description: app.description,
            published,
            kbNames,
          });
          setMetaLoading(false);
        }
      } catch {
        if (alive) {
          setMeta(null);
          setMetaLoading(false);
          antdMessage.error("加载应用信息失败");
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [agentId]);

  const reloadConvs = useCallback(async () => {
    if (!meta?.published) return;
    try {
      setConvs(await getConversations(meta.applicationId));
    } catch {
      // 列表可空，静默
    }
  }, [meta]);

  useEffect(() => {
    void reloadConvs();
  }, [reloadConvs]);

  // 卸载时 abort 进行中的流 + 清复制计时器
  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  // 新消息 / typing 出现时滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  const pickConv = async (id: string) => {
    setConvId(id);
    setCiteSel(null);
    try {
      const history = await getMessages(id);
      setMsgs(history.map(historyToView));
    } catch {
      antdMessage.error("加载会话失败");
    }
  };

  const newConv = () => {
    setConvId(undefined);
    setMsgs([]);
    setCiteSel(null);
  };

  // 事件 reducer：token 追加、citation 累积、done 定格 + 回填 convId、error 收尾
  const applyEvent = (botKey: string, ev: ChatStreamEvent) => {
    setMsgs((prev) =>
      prev.map((m) => {
        if (m.key !== botKey) return m;
        switch (ev.type) {
          case "token":
            return { ...m, text: m.text + ev.delta };
          case "citation":
            return { ...m, citations: [...m.citations, ev.citation] };
          case "done":
            return {
              ...m,
              streaming: false,
              confidence: ev.confidence,
              coverage: ev.coverage,
              isFallback: ev.isFallback,
              fallbackReasons: ev.fallbackReasons,
            };
          case "error":
            return { ...m, streaming: false, errored: ev.message };
          default:
            return m;
        }
      }),
    );
    if (ev.type === "done") {
      if (!convId && ev.convId) setConvId(ev.convId); // 新会话回填
      void reloadConvs();
    }
  };

  const send = async () => {
    const query = draft.trim();
    if (!query || sending || !meta?.published) return;
    setDraft("");
    setSending(true);
    const stamp = `${Date.now()}-${msgs.length}`;
    const botKey = `a-${stamp}`;
    setMsgs((prev) => [
      ...prev,
      {
        key: `u-${stamp}`,
        role: "user",
        text: query,
        citations: [],
        isFallback: false,
        fallbackReasons: [],
        streaming: false,
      },
      {
        key: botKey,
        role: "assistant",
        text: "",
        citations: [],
        isFallback: false,
        fallbackReasons: [],
        streaming: true,
      },
    ]);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      for await (const ev of openChatStream(
        { agentId: meta.applicationId, query, convId },
        ac.signal,
      )) {
        applyEvent(botKey, ev);
      }
    } catch (e) {
      const errored =
        e instanceof ChatStreamError && (e.status === 404 || e.status === 403)
          ? "该 Agent 当前不可用"
          : "生成失败，请稍后重试";
      setMsgs((prev) =>
        prev.map((m) => (m.key === botKey ? { ...m, streaming: false, errored } : m)),
      );
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  };

  const onComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const pickCite = (msgKey: string, n: number) => {
    setCiteSel({ msgKey, n });
    setRightOpen(true);
  };

  const onCopy = (key: string, text: string) => {
    try {
      navigator.clipboard?.writeText(plainText(text));
    } catch {
      /* 非安全上下文静默 */
    }
    setCopied(key);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(
      () => setCopied((prev) => (prev === key ? null : prev)),
      COPIED_RESET_MS,
    );
  };

  const toggleFb = (key: string, v: "up" | "down") =>
    setFeedback((f) => {
      const next = { ...f };
      if (next[key] === v) delete next[key];
      else next[key] = v;
      return next;
    });

  const onLogout = () => {
    localStorage.removeItem("token");
    navigate("/login", { replace: true });
  };

  // 右栏 citation 来源消息（选中优先，否则最近一条带 citation 的 assistant 消息）+ 列表 + 详情
  const rightSource = useMemo(() => {
    const m = citeSel ? msgs.find((x) => x.key === citeSel.msgKey) : null;
    return (
      m ??
      [...msgs].reverse().find((x) => x.role === "assistant" && x.citations.length > 0) ??
      null
    );
  }, [citeSel, msgs]);
  const rightCites = rightSource?.citations ?? [];

  const selectedCite = useMemo(() => {
    if (!citeSel) return null;
    const m = msgs.find((x) => x.key === citeSel.msgKey);
    return m?.citations.find((c) => c.n === citeSel.n) ?? null;
  }, [citeSel, msgs]);

  if (metaLoading) {
    return (
      <div
        style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        <Spin />
      </div>
    );
  }

  // 未上线 / 应用不存在 → 占位屏
  if (!meta || !meta.published) {
    const name = meta?.name ?? "该应用";
    return (
      <div style={{ height: "100%", display: "flex", background: "#f0f2f5" }}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
          <div style={{ maxWidth: 420, textAlign: "center" }}>
            <div
              style={{
                width: 64,
                height: 64,
                margin: "0 auto 18px",
                borderRadius: 16,
                background: AGENT_COLOR,
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 26,
                fontWeight: 600,
                opacity: 0.5,
              }}
            >
              {initialOf(name)}
            </div>
            <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>
              {meta ? "该 Agent 尚未上线" : "未找到该应用"}
            </div>
            <div style={{ fontSize: 13, color: "rgba(0,0,0,.5)", lineHeight: 1.8, marginBottom: 20 }}>
              {meta
                ? `「${name}」还没有配置版本被打上 production 标识，暂不可对外服务。到管理台把 production 标识打到某个配置版本即可上线。`
                : "请检查访问地址是否正确。"}
            </div>
            <div
              onClick={() => navigate("/admin")}
              style={{
                display: "inline-flex",
                height: 38,
                padding: "0 20px",
                background: "#1677ff",
                color: "#fff",
                borderRadius: 8,
                alignItems: "center",
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              去管理台配置 →
            </div>
          </div>
        </div>
      </div>
    );
  }

  const sendBg = draft.trim() ? "#1677ff" : "#bfbfbf";
  const anyStreaming = msgs.some((m) => m.streaming && m.text === "");

  return (
    <div style={{ height: "100%", display: "flex", background: "#f0f2f5", overflow: "hidden" }}>
      <style>{`@keyframes ccb-blink{0%,60%,100%{opacity:.25}30%{opacity:1}}
.ccb-md{font-size:14px;line-height:1.8;word-break:break-word}
.ccb-md>*:first-child{margin-top:0}
.ccb-md>*:last-child{margin-bottom:0}
.ccb-md p{margin:0 0 8px}
.ccb-md ul,.ccb-md ol{margin:4px 0;padding-left:22px}
.ccb-md li{margin:2px 0}
.ccb-md li>p{margin:0}
.ccb-md h1,.ccb-md h2,.ccb-md h3,.ccb-md h4{margin:12px 0 6px;font-weight:600;line-height:1.4}
.ccb-md h1{font-size:18px}.ccb-md h2{font-size:16px}.ccb-md h3{font-size:15px}.ccb-md h4{font-size:14px}
.ccb-md code{background:#f5f5f5;border-radius:4px;padding:1px 5px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px}
.ccb-md pre{background:#f6f8fa;border:1px solid #eaecef;border-radius:8px;padding:12px;overflow-x:auto;margin:8px 0}
.ccb-md pre code{background:none;padding:0;font-size:12.5px}
.ccb-md blockquote{margin:8px 0;padding:2px 12px;border-left:3px solid #d9d9d9;color:rgba(0,0,0,.6)}
.ccb-md table{border-collapse:collapse;margin:8px 0;font-size:13px;display:block;overflow-x:auto}
.ccb-md th,.ccb-md td{border:1px solid #e8e8e8;padding:5px 10px}
.ccb-md hr{border:none;border-top:1px solid #f0f0f0;margin:12px 0}
.ccb-md strong{font-weight:600}
.ccb-md a{color:#1677ff;text-decoration:none}`}</style>

      {/* 左侧栏：单 Agent 信息卡 + 新建会话 + 会话历史 + 账号区 */}
      <div
        style={{
          width: 280,
          flex: "none",
          background: "#fff",
          borderRight: "1px solid #f0f0f0",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "16px 16px 10px" }}>
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              background: "#1677ff",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              fontSize: 11,
            }}
          >
            CC
          </div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>CodeCrushBot</div>
        </div>

        {/* Agent 信息卡 */}
        <div
          style={{
            margin: "6px 12px 10px",
            padding: 14,
            border: "1px solid #f0f0f0",
            borderRadius: 10,
            background: "#fafafa",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                width: 40,
                height: 40,
                flex: "none",
                borderRadius: 10,
                background: AGENT_COLOR,
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 17,
                fontWeight: 600,
              }}
            >
              {initialOf(meta.name)}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{meta.name}</div>
              <div
                style={{
                  fontSize: 12,
                  color: "rgba(0,0,0,.45)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {meta.description}
              </div>
            </div>
          </div>
        </div>

        <div style={{ padding: "2px 12px 6px" }}>
          <div
            onClick={newConv}
            style={{
              height: 36,
              border: "1px dashed #d9d9d9",
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              fontSize: 13,
              color: "rgba(0,0,0,.65)",
              cursor: "pointer",
              userSelect: "none",
            }}
          >
            ＋ 新建会话
          </div>
        </div>

        <div style={{ padding: "6px 16px 6px", fontSize: 12, color: "rgba(0,0,0,.45)" }}>会话历史</div>
        <div style={{ flex: 1, overflowY: "auto", padding: "0 12px", minHeight: 0 }}>
          {convs.map((cv) => {
            const on = cv.id === convId;
            const time = cv.updatedAt ? cv.updatedAt.slice(5, 16).replace("T", " ") : "";
            return (
              <div
                key={cv.id}
                onClick={() => void pickConv(cv.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  padding: "9px 12px",
                  borderRadius: 6,
                  background: on ? "#e6f4ff" : "transparent",
                  cursor: "pointer",
                  marginBottom: 2,
                }}
              >
                <div
                  style={{
                    minWidth: 0,
                    fontSize: 13,
                    fontWeight: on ? 600 : 400,
                    color: on ? "#1677ff" : "rgba(0,0,0,.88)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {cv.title}
                </div>
                <div style={{ flex: "none", fontSize: 12, color: "rgba(0,0,0,.35)" }}>{time}</div>
              </div>
            );
          })}
        </div>

        <div
          style={{
            borderTop: "1px solid #f0f0f0",
            padding: "10px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <div style={{ padding: "7px 12px", borderRadius: 6, fontSize: 13, color: "rgba(0,0,0,.65)" }}>
            账号设置
          </div>
          <div style={{ padding: "7px 12px", borderRadius: 6, fontSize: 13, color: "rgba(0,0,0,.65)" }}>
            帮助中心
          </div>
          <div
            onClick={() => navigate("/admin")}
            style={{ padding: "7px 12px", borderRadius: 6, fontSize: 13, color: "#1677ff", cursor: "pointer" }}
          >
            管理后台 →
          </div>
          <div
            onClick={onLogout}
            style={{
              padding: "7px 12px",
              borderRadius: 6,
              fontSize: 13,
              color: "rgba(0,0,0,.45)",
              cursor: "pointer",
              marginTop: 4,
              borderTop: "1px solid #f0f0f0",
            }}
          >
            退出
          </div>
        </div>
      </div>

      {/* 中间聊天 */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          background: "#fff",
          borderRight: "1px solid #f0f0f0",
        }}
      >
        <div
          style={{
            height: 56,
            flex: "none",
            borderBottom: "1px solid #f0f0f0",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "0 20px",
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600 }}>{meta.name}</div>
          {meta.kbNames.map((kb) => (
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
          ))}
          <div style={{ flex: 1 }} />
          <div
            onClick={() => setRightOpen((o) => !o)}
            style={{
              fontSize: 13,
              color: "rgba(0,0,0,.55)",
              cursor: "pointer",
              padding: "4px 10px",
              borderRadius: 6,
            }}
          >
            {rightOpen ? "收起引用 »" : "« 引用原文"}
          </div>
        </div>

        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "24px 28px",
            display: "flex",
            flexDirection: "column",
            gap: 20,
            minHeight: 0,
            background: "#fafafa",
          }}
        >
          {msgs.map((m) => {
            // 首 token 前不渲染空 assistant 气泡——由下方 typing 三点独占该态（避免空气泡 + 三点叠现）
            if (m.role === "assistant" && m.streaming && m.text === "" && !m.errored) return null;
            return m.role === "user" ? (
              <div key={m.key} style={{ display: "flex", flexDirection: "column" }}>
                <div
                  style={{
                    alignSelf: "flex-end",
                    maxWidth: "70%",
                    background: "#1677ff",
                    color: "#fff",
                    padding: "10px 14px",
                    borderRadius: "10px 10px 2px 10px",
                    fontSize: 14,
                    lineHeight: 1.7,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {m.text}
                </div>
              </div>
            ) : (
              <div key={m.key} style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: "82%" }}>
                <div style={{ display: "flex", gap: 10 }}>
                  <div
                    style={{
                      width: 30,
                      height: 30,
                      flex: "none",
                      borderRadius: 8,
                      background: AGENT_COLOR,
                      color: "#fff",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 13,
                      fontWeight: 600,
                    }}
                  >
                    {initialOf(meta.name)}
                  </div>
                  <div
                    style={{
                      background: "#fff",
                      border: "1px solid #f0f0f0",
                      padding: "12px 16px",
                      borderRadius: "2px 10px 10px 10px",
                      fontSize: 14,
                      lineHeight: 1.8,
                      boxShadow: "0 1px 2px rgba(0,0,0,.03)",
                    }}
                  >
                    {m.errored ? (
                      <span style={{ color: "#ff4d4f" }}>{m.errored}</span>
                    ) : (
                      <MessageMarkdown
                        text={m.text}
                        msgKey={m.key}
                        citations={m.citations}
                        activeN={citeSel?.msgKey === m.key ? citeSel.n : null}
                        onPickCite={pickCite}
                      />
                    )}
                  </div>
                </div>

                {/* 可信度页脚（流式结束后才定格） */}
                {!m.streaming && !m.errored && (
                  <div style={{ marginLeft: 40, display: "flex", flexDirection: "column", gap: 8 }}>
                    {m.isFallback && (
                      <div
                        style={{
                          border: "1px solid #ffe58f",
                          background: "#fffbe6",
                          borderRadius: 10,
                          padding: "12px 14px",
                          display: "flex",
                          flexDirection: "column",
                          gap: 9,
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span
                            style={{
                              width: 20,
                              height: 20,
                              flex: "none",
                              borderRadius: 5,
                              background: "#faad14",
                              color: "#fff",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontSize: 12,
                              fontWeight: 700,
                            }}
                          >
                            !
                          </span>
                          <span style={{ fontSize: 13, fontWeight: 600, color: "#874d00" }}>
                            未在知识库中找到匹配内容 · 已兜底回复
                          </span>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                          {m.fallbackReasons.map((r, i) => {
                            const label = FALLBACK_REASON_LABEL[r] ?? { k: r, v: "" };
                            return (
                              <div key={i} style={{ display: "flex", gap: 8, fontSize: 12, lineHeight: 1.6 }}>
                                <span style={{ flex: "none", color: "#d48806", fontWeight: 600, minWidth: 56 }}>
                                  {label.k}
                                </span>
                                <span style={{ color: "rgba(0,0,0,.6)" }}>{label.v}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {!m.isFallback && m.confidence != null && isCited(m) && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                        {(() => {
                          const lv = levelOf(m.confidence);
                          return (
                            <div
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 6,
                                height: 26,
                                padding: "0 11px",
                                borderRadius: 13,
                                background: lv.bg,
                                border: `1px solid ${lv.bd}`,
                              }}
                            >
                              <span style={{ width: 6, height: 6, borderRadius: "50%", background: lv.c }} />
                              <span style={{ fontSize: 12, fontWeight: 600, color: lv.c }}>
                                可信度 {lv.l} · {Math.round(m.confidence * 100)}%
                              </span>
                            </div>
                          );
                        })()}
                        <div
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            height: 26,
                            padding: "0 11px",
                            borderRadius: 13,
                            background: "#fff",
                            border: "1px solid #f0f0f0",
                          }}
                        >
                          <span
                            style={{
                              fontSize: 12,
                              fontWeight: 700,
                              color: m.coverage === "full" ? "#52c41a" : "#d46b08",
                            }}
                          >
                            {m.coverage === "full" ? "✓" : "!"}
                          </span>
                          <span style={{ fontSize: 12, color: "rgba(0,0,0,.7)" }}>
                            {m.coverage === "full" ? "引用完整" : "引用不完整"}
                          </span>
                          <span style={{ fontSize: 12, color: "rgba(0,0,0,.35)" }}>
                            · {m.coverage === "full" ? "关键结论均有原文支撑" : "部分内容缺少直接来源"}
                          </span>
                        </div>
                      </div>
                    )}

                    {!m.isFallback && m.confidence != null && m.confidence < 0.7 && isCited(m) && (
                      <div
                        style={{
                          display: "flex",
                          gap: 8,
                          alignItems: "flex-start",
                          padding: "9px 12px",
                          borderRadius: 8,
                          background: "#fff7e6",
                          border: "1px solid #ffd591",
                        }}
                      >
                        <span style={{ flex: "none", color: "#d46b08", fontSize: 13, lineHeight: 1.5 }}>⚠</span>
                        <span style={{ fontSize: 12, color: "#874d00", lineHeight: 1.6 }}>
                          该回答可信度较低，可能不完全准确。建议点击角标核对原文，或转人工确认后再采用。
                        </span>
                      </div>
                    )}

                    {/* 操作栏 */}
                    <div style={{ display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}>
                      <div
                        onClick={() => onCopy(m.key, m.text)}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 5,
                          height: 28,
                          padding: "0 9px",
                          borderRadius: 6,
                          fontSize: 12,
                          color: "rgba(0,0,0,.5)",
                          cursor: "pointer",
                          userSelect: "none",
                        }}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="9" y="9" width="13" height="13" rx="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                        {copied === m.key ? <span style={{ color: "#52c41a" }}>已复制</span> : <span>复制</span>}
                      </div>
                      <div
                        onClick={() => toggleFb(m.key, "up")}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 5,
                          height: 28,
                          padding: "0 9px",
                          borderRadius: 6,
                          fontSize: 12,
                          cursor: "pointer",
                          userSelect: "none",
                          color: feedback[m.key] === "up" ? "#1677ff" : "rgba(0,0,0,.5)",
                          background: feedback[m.key] === "up" ? "#e6f4ff" : "transparent",
                        }}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
                        </svg>
                        <span>有帮助</span>
                      </div>
                      <div
                        onClick={() => toggleFb(m.key, "down")}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 5,
                          height: 28,
                          padding: "0 9px",
                          borderRadius: 6,
                          fontSize: 12,
                          cursor: "pointer",
                          userSelect: "none",
                          color: feedback[m.key] === "down" ? "#ff4d4f" : "rgba(0,0,0,.5)",
                          background: feedback[m.key] === "down" ? "#fff2f0" : "transparent",
                        }}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" />
                        </svg>
                        <span>不准确</span>
                      </div>
                    </div>

                    {feedback[m.key] === "down" && (
                      <div style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>
                        已记录您的反馈，我们会用于优化该 Agent 的回答质量。
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {anyStreaming && (
            <div style={{ display: "flex", gap: 10 }}>
              <div
                style={{
                  width: 30,
                  height: 30,
                  flex: "none",
                  borderRadius: 8,
                  background: AGENT_COLOR,
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                {initialOf(meta.name)}
              </div>
              <div
                style={{
                  background: "#fff",
                  border: "1px solid #f0f0f0",
                  padding: "14px 16px",
                  borderRadius: "2px 10px 10px 10px",
                  display: "flex",
                  gap: 5,
                  alignItems: "center",
                }}
              >
                {[0, 0.2, 0.4].map((d) => (
                  <div
                    key={d}
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: "#1677ff",
                      animation: `ccb-blink 1.2s ${d}s infinite`,
                    }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        <div style={{ flex: "none", borderTop: "1px solid #f0f0f0", padding: "14px 20px", background: "#fff" }}>
          <div
            style={{
              display: "flex",
              gap: 10,
              alignItems: "flex-end",
              border: "1px solid #d9d9d9",
              borderRadius: 10,
              padding: "10px 12px",
            }}
          >
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onComposerKey}
              placeholder="输入您的问题，Enter 发送…"
              style={{
                flex: 1,
                border: "none",
                outline: "none",
                resize: "none",
                fontSize: 14,
                lineHeight: 1.6,
                height: 44,
                padding: 0,
                fontFamily: "inherit",
              }}
            />
            <button
              type="button"
              onClick={() => void send()}
              style={{
                flex: "none",
                height: 32,
                padding: "0 16px",
                borderRadius: 6,
                background: sendBg,
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 13,
                cursor: "pointer",
                border: "none",
              }}
            >
              发送
            </button>
          </div>
          <div style={{ fontSize: 12, color: "rgba(0,0,0,.3)", marginTop: 6 }}>
            回答由 AI 基于知识库生成，点击角标可查看原文出处
          </div>
        </div>
      </div>

      {/* 右侧引用原文 */}
      {rightOpen && (
        <div
          style={{
            width: 340,
            flex: "none",
            background: "#fff",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <div
            style={{
              height: 56,
              flex: "none",
              borderBottom: "1px solid #f0f0f0",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0 16px",
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600 }}>引用原文</div>
            <div
              onClick={() => setRightOpen(false)}
              style={{
                fontSize: 16,
                color: "rgba(0,0,0,.45)",
                cursor: "pointer",
                width: 24,
                height: 24,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 4,
              }}
            >
              ×
            </div>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 16, minHeight: 0 }}>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginBottom: 8 }}>
              本会话命中知识 · {rightCites.length} 条
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
              {rightCites.map((ct) => {
                const on = selectedCite?.n === ct.n;
                return (
                  <div
                    key={ct.n}
                    onClick={() =>
                      rightSource && setCiteSel({ msgKey: rightSource.key, n: ct.n })
                    }
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "8px 10px",
                      borderRadius: 6,
                      border: `1px solid ${on ? "#1677ff" : "#f0f0f0"}`,
                      background: on ? "#e6f4ff" : "#fff",
                      cursor: "pointer",
                    }}
                  >
                    <span
                      style={{
                        flex: "none",
                        minWidth: 16,
                        height: 16,
                        padding: "0 3px",
                        borderRadius: 4,
                        background: on ? "#1677ff" : "#f0f0f0",
                        color: on ? "#fff" : "rgba(0,0,0,.65)",
                        fontSize: 11,
                        fontWeight: 600,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {ct.n}
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        color: "rgba(0,0,0,.65)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {ct.section}
                    </span>
                    <span style={{ flex: "none", marginLeft: "auto", fontSize: 11, color: "rgba(0,0,0,.35)" }}>
                      {ct.score.toFixed(2)}
                    </span>
                  </div>
                );
              })}
            </div>
            {selectedCite ? (
              <div style={{ border: "1px solid #f0f0f0", borderRadius: 8, overflow: "hidden" }}>
                <div style={{ padding: "12px 14px", background: "#fafafa", borderBottom: "1px solid #f0f0f0" }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>《{selectedCite.doc}》</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <span
                      style={{
                        fontSize: 11,
                        lineHeight: "18px",
                        padding: "0 6px",
                        borderRadius: 4,
                        background: "#e6f4ff",
                        color: "#1677ff",
                        border: "1px solid #91caff",
                      }}
                    >
                      {selectedCite.kb}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        lineHeight: "18px",
                        padding: "0 6px",
                        borderRadius: 4,
                        background: "#f6ffed",
                        color: "#52c41a",
                        border: "1px solid #b7eb8f",
                      }}
                    >
                      相似度 {selectedCite.score.toFixed(2)}
                    </span>
                  </div>
                </div>
                <div style={{ padding: 14 }}>
                  <div
                    style={{
                      borderLeft: "3px solid #1677ff",
                      background: "#e6f4ff",
                      borderRadius: "0 6px 6px 0",
                      padding: "10px 12px",
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 600, color: "#1677ff", marginBottom: 4 }}>
                      {selectedCite.section}
                    </div>
                    <div style={{ fontSize: 13, lineHeight: 1.9 }}>{selectedCite.text ?? ""}</div>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ padding: "40px 20px", textAlign: "center", color: "rgba(0,0,0,.3)", fontSize: 13, lineHeight: 1.8 }}>
                点击回答中的{" "}
                <span
                  style={{
                    display: "inline-flex",
                    minWidth: 16,
                    height: 16,
                    borderRadius: 4,
                    background: "#e6f4ff",
                    color: "#1677ff",
                    fontSize: 11,
                    fontWeight: 600,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  1
                </span>{" "}
                角标
                <br />
                查看命中的知识原文
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
