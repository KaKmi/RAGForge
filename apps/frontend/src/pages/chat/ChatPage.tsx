import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AGENTS,
  BASEMSGS,
  CANNED_REPLY,
  CITES,
  CONVS,
  WELCOME,
  type BaseMsg,
} from "../../mocks/conversations";

/** C 端问答页：1:1 还原原型三栏（Agent/会话列表 + 消息流 + 引用原文）。
 * M2 全前端 mock 本地态：Agent 切换 / 会话切换 / 角标点击 / 复制 / 反馈 / 转人工 / 打字机均为本地状态。
 * M8 将 send 与初始会话替换为真实 /api/chat SSE 流，引用详情走检索接口。 */

const USER_EMAIL = "demo@codecrush.bot";
const REPLY_DELAY_MS = 1100;

interface PartView {
  isCite: boolean;
  text?: string;
  n?: number;
  bg?: string;
  fg?: string;
  citeId?: string;
}

interface MsgView {
  isUser: boolean;
  key: string;
  text?: string;
  parts?: PartView[];
  isFallback: boolean;
  showTrust: boolean;
  showLow: boolean;
  confPct: number;
  confLabel: string;
  confColor: string;
  confBg: string;
  confBd: string;
  coverLabel: string;
  coverSub: string;
  coverColor: string;
  coverIcon: string;
  fbReasons: { k: string; v: string }[];
  plain: string;
  upActive: boolean;
  downActive: boolean;
  copied: boolean;
  handoffDone: boolean;
  showFbNote: boolean;
}

function levelOf(conf: number) {
  if (conf >= 0.85) return { l: "高", c: "#52c41a", bg: "#f6ffed", bd: "#b7eb8f" };
  if (conf >= 0.7) return { l: "中", c: "#d48806", bg: "#fffbe6", bd: "#ffe58f" };
  return { l: "低", c: "#ff4d4f", bg: "#fff2f0", bd: "#ffccc7" };
}

export default function ChatPage() {
  const navigate = useNavigate();
  const [agentId, setAgentId] = useState("aftersale");
  const [convId, setConvId] = useState("c1");
  const [citeId, setCiteId] = useState<string | null>(null);
  const [rightOpen, setRightOpen] = useState(true);
  const [draft, setDraft] = useState("");
  const [typing, setTyping] = useState(false);
  const [extras, setExtras] = useState<Record<string, BaseMsg[]>>({});
  const [feedback, setFeedback] = useState<Record<string, "up" | "down">>({});
  const [handoff, setHandoff] = useState<Record<string, true>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const replyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      if (replyTimer.current) clearTimeout(replyTimer.current);
    };
  }, []);

  // 新消息 / 打字态出现时滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [extras, convId, agentId, typing]);

  const agent = AGENTS.find((a) => a.id === agentId) ?? AGENTS[0];

  const { msgs, citeList, cite } = useMemo(() => {
    const base: BaseMsg[] =
      convId === "new"
        ? [{ r: "a", p: [{ t: WELCOME[agentId] ?? "" }] }]
        : (BASEMSGS[convId] ?? []);
    const all = base.concat(extras[convId] ?? []);
    const seen: string[] = [];

    const built: MsgView[] = all.map((m, mi) => {
      const key = `${convId}:${mi}`;
      if (m.r === "u") {
        return {
          isUser: true, key, text: m.t,
          isFallback: false, showTrust: false, showLow: false,
          confPct: 0, confLabel: "", confColor: "", confBg: "", confBd: "",
          coverLabel: "", coverSub: "", coverColor: "", coverIcon: "",
          fbReasons: [], plain: m.t,
          upActive: false, downActive: false, copied: false, handoffDone: false, showFbNote: false,
        };
      }
      const parts: PartView[] = (m.p ?? []).map((p) => {
        if ("c" in p) {
          if (!seen.includes(p.c)) seen.push(p.c);
          const k = CITES[p.c];
          const on = citeId === p.c;
          return { isCite: true, n: k.n, bg: on ? "#1677ff" : "#e6f4ff", fg: on ? "#fff" : "#1677ff", citeId: p.c };
        }
        return { isCite: false, text: p.t };
      });
      const plain = (m.p ?? []).filter((p) => "t" in p).map((p) => p.t).join("");
      const isFallback = !!m.fallback;
      let confPct = 0, confLabel = "", confColor = "", confBg = "", confBd = "";
      let coverLabel = "", coverSub = "", coverColor = "", coverIcon = "";
      let showLow = false;
      let fbReasons: { k: string; v: string }[] = [];
      if (isFallback && m.fallback) {
        fbReasons = [
          { k: "超出范围", v: "问题不属于该 Agent 已接入的知识库主题" },
          { k: "相似度过低", v: `检索最高相似度 ${m.fallback.top}，低于命中阈值 ${m.fallback.thr}` },
          { k: "检索范围", v: m.fallback.scope },
          { k: "已处理", v: "按「兜底话术」策略回复，未编造知识库外内容" },
        ];
      } else {
        const conf = m.conf ?? 0.9;
        confPct = Math.round(conf * 100);
        const lv = levelOf(conf);
        confLabel = lv.l; confColor = lv.c; confBg = lv.bg; confBd = lv.bd;
        const full = (m.cover ?? "full") === "full";
        coverLabel = full ? "引用完整" : "引用不完整";
        coverSub = full ? "关键结论均有原文支撑" : "部分内容缺少直接来源";
        coverColor = full ? "#52c41a" : "#d46b08";
        coverIcon = full ? "✓" : "!";
        showLow = conf < 0.7;
      }
      const fbv = feedback[key];
      return {
        isUser: false, key, parts,
        isFallback, showTrust: !isFallback, showLow,
        confPct, confLabel, confColor, confBg, confBd,
        coverLabel, coverSub, coverColor, coverIcon, fbReasons, plain,
        upActive: fbv === "up", downActive: fbv === "down",
        copied: copied === key, handoffDone: !!handoff[key], showFbNote: fbv === "down",
      };
    });

    const list = seen.map((id) => {
      const k = CITES[id];
      const on = citeId === id;
      return {
        id, n: k.n, sec: k.sec, score: k.score,
        bd: on ? "#1677ff" : "#f0f0f0", bg: on ? "#e6f4ff" : "#fff",
        nBg: on ? "#1677ff" : "#f0f0f0", nFg: on ? "#fff" : "rgba(0,0,0,.65)",
      };
    });
    const c = citeId ? CITES[citeId] : null;
    return { msgs: built, citeList: list, cite: c };
  }, [agentId, convId, extras, citeId, feedback, handoff, copied]);

  // ---- 交互 ----
  const pickAgent = (id: string) => {
    const first = CONVS.find((c) => c.agent === id);
    setAgentId(id);
    setConvId(first ? first.id : "new");
    setCiteId(null);
  };
  const pickConv = (id: string) => {
    const c = CONVS.find((x) => x.id === id);
    setConvId(id);
    if (c) setAgentId(c.agent);
    setCiteId(null);
  };
  const newConv = () => {
    setConvId("new");
    setCiteId(null);
  };
  const pickCite = (id: string) => {
    setCiteId(id);
    setRightOpen(true);
  };
  const onCopy = (key: string, text: string) => {
    try {
      navigator.clipboard?.writeText(text);
    } catch {
      /* clipboard 在非安全上下文不可用，静默 */
    }
    setCopied(key);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied((prev) => (prev === key ? null : prev)), 1600);
  };
  const onUp = (key: string) =>
    setFeedback((f) => {
      const next = { ...f };
      if (next[key] === "up") delete next[key];
      else next[key] = "up";
      return next;
    });
  const onDown = (key: string) =>
    setFeedback((f) => {
      const next = { ...f };
      if (next[key] === "down") delete next[key];
      else next[key] = "down";
      return next;
    });
  const onHandoff = (key: string) => setHandoff((h) => ({ ...h, [key]: true }));

  const send = () => {
    const text = draft.trim();
    if (!text || typing) return;
    const cid = convId;
    setExtras((e) => ({ ...e, [cid]: (e[cid] ?? []).concat([{ r: "u", t: text }]) }));
    setDraft("");
    setTyping(true);
    replyTimer.current = setTimeout(() => {
      setExtras((e) => ({ ...e, [cid]: (e[cid] ?? []).concat([CANNED_REPLY]) }));
      setTyping(false);
    }, REPLY_DELAY_MS);
  };

  const onComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const onLogout = () => {
    localStorage.removeItem("token");
    navigate("/login", { replace: true });
  };

  const sendBg = draft.trim() ? "#1677ff" : "#bfbfbf";

  return (
    <div style={{ height: "100%", display: "flex", background: "#f0f2f5" }}>
      <style>{`@keyframes ccb-blink{0%,60%,100%{opacity:.25}30%{opacity:1}}`}</style>

      {/* 左侧栏 */}
      <div
        style={{
          width: 280, flex: "none", background: "#fff",
          borderRight: "1px solid #f0f0f0", display: "flex", flexDirection: "column", minHeight: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "16px 16px 12px" }}>
          <div
            style={{
              width: 28, height: 28, borderRadius: 6, background: "#1677ff", color: "#fff",
              display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 11,
            }}
          >
            CC
          </div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>CodeCrushBot</div>
        </div>
        <div style={{ padding: "4px 16px 8px", fontSize: 12, color: "rgba(0,0,0,.45)" }}>知识库 Agent</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 12px" }}>
          {AGENTS.map((ag) => {
            const on = ag.id === agentId;
            return (
              <div
                key={ag.id}
                onClick={() => pickAgent(ag.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 8,
                  border: `1px solid ${on ? "#1677ff" : "#f0f0f0"}`, background: on ? "#e6f4ff" : "#fff",
                  cursor: "pointer",
                }}
              >
                <div
                  style={{
                    width: 32, height: 32, flex: "none", borderRadius: 8, background: ag.color, color: "#fff",
                    display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 600,
                  }}
                >
                  {ag.name[0]}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: on ? 600 : 400 }}>{ag.name}</div>
                  <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)" }}>{ag.desc}</div>
                </div>
                <div
                  style={{
                    width: 8, height: 8, flex: "none", borderRadius: "50%", background: on ? "#1677ff" : "transparent",
                  }}
                />
              </div>
            );
          })}
        </div>
        <div style={{ padding: "14px 12px 6px" }}>
          <div
            onClick={newConv}
            style={{
              height: 36, border: "1px dashed #d9d9d9", borderRadius: 6, display: "flex",
              alignItems: "center", justifyContent: "center", gap: 6, fontSize: 13,
              color: "rgba(0,0,0,.65)", cursor: "pointer", userSelect: "none",
            }}
          >
            ＋ 新建会话
          </div>
        </div>
        <div style={{ padding: "6px 16px 6px", fontSize: 12, color: "rgba(0,0,0,.45)" }}>会话</div>
        <div style={{ flex: 1, overflowY: "auto", padding: "0 12px", minHeight: 0 }}>
          {CONVS.map((cv) => {
            const on = cv.id === convId;
            const ag = AGENTS.find((a) => a.id === cv.agent);
            return (
              <div
                key={cv.id}
                onClick={() => pickConv(cv.id)}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
                  padding: "9px 12px", borderRadius: 6, background: on ? "#e6f4ff" : "transparent",
                  cursor: "pointer", marginBottom: 2,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13, fontWeight: on ? 600 : 400, color: on ? "#1677ff" : "rgba(0,0,0,.88)",
                      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    }}
                  >
                    {cv.title}
                  </div>
                  <div style={{ fontSize: 12, color: "rgba(0,0,0,.35)" }}>{ag?.name ?? ""}</div>
                </div>
                <div style={{ flex: "none", fontSize: 12, color: "rgba(0,0,0,.35)" }}>{cv.time}</div>
              </div>
            );
          })}
        </div>
        <div
          style={{
            borderTop: "1px solid #f0f0f0", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 2,
          }}
        >
          <div style={{ padding: "7px 12px", borderRadius: 6, fontSize: 13, color: "rgba(0,0,0,.65)" }}>账号设置</div>
          <div style={{ padding: "7px 12px", borderRadius: 6, fontSize: 13, color: "rgba(0,0,0,.65)" }}>帮助中心</div>
          <div
            onClick={() => navigate("/admin")}
            style={{ padding: "7px 12px", borderRadius: 6, fontSize: 13, color: "#1677ff", cursor: "pointer" }}
          >
            管理后台 →
          </div>
          <div
            style={{
              display: "flex", alignItems: "center", gap: 10, padding: "10px 12px 4px", marginTop: 4,
              borderTop: "1px solid #f0f0f0",
            }}
          >
            <div
              style={{
                width: 30, height: 30, borderRadius: "50%", background: "#87d068", color: "#fff",
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13,
              }}
            >
              刘
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>刘敏</div>
              <div
                style={{
                  fontSize: 12, color: "rgba(0,0,0,.4)", whiteSpace: "nowrap",
                  overflow: "hidden", textOverflow: "ellipsis",
                }}
              >
                {USER_EMAIL}
              </div>
            </div>
            <div
              onClick={onLogout}
              style={{ flex: "none", fontSize: 12, color: "rgba(0,0,0,.45)", cursor: "pointer" }}
            >
              退出
            </div>
          </div>
        </div>
      </div>

      {/* 中间聊天 */}
      <div
        style={{
          flex: 1, minWidth: 0, display: "flex", flexDirection: "column",
          background: "#fff", borderRight: "1px solid #f0f0f0",
        }}
      >
        <div
          style={{
            height: 56, flex: "none", borderBottom: "1px solid #f0f0f0", display: "flex",
            alignItems: "center", gap: 10, padding: "0 20px",
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600 }}>{agent.name}</div>
          {agent.kbs.map((kb) => (
            <span
              key={kb}
              style={{
                fontSize: 12, lineHeight: "20px", padding: "0 8px", borderRadius: 4,
                background: "#e6f4ff", color: "#1677ff", border: "1px solid #91caff",
              }}
            >
              {kb}
            </span>
          ))}
          <div style={{ flex: 1 }} />
          <div
            onClick={() => setRightOpen((o) => !o)}
            style={{
              fontSize: 13, color: "rgba(0,0,0,.55)", cursor: "pointer", padding: "4px 10px", borderRadius: 6,
            }}
          >
            {rightOpen ? "收起引用 »" : "« 引用原文"}
          </div>
        </div>

        <div
          ref={scrollRef}
          style={{
            flex: 1, overflowY: "auto", padding: "24px 28px", display: "flex",
            flexDirection: "column", gap: 20, minHeight: 0, background: "#fafafa",
          }}
        >
          {msgs.map((m) =>
            m.isUser ? (
              <div key={m.key} style={{ display: "flex", flexDirection: "column" }}>
                <div
                  style={{
                    alignSelf: "flex-end", maxWidth: "70%", background: "#1677ff", color: "#fff",
                    padding: "10px 14px", borderRadius: "10px 10px 2px 10px", fontSize: 14,
                    lineHeight: 1.7, whiteSpace: "pre-wrap",
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
                      width: 30, height: 30, flex: "none", borderRadius: 8, background: agent.color, color: "#fff",
                      display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600,
                    }}
                  >
                    {agent.name[0]}
                  </div>
                  <div
                    style={{
                      background: "#fff", border: "1px solid #f0f0f0", padding: "12px 16px",
                      borderRadius: "2px 10px 10px 10px", fontSize: 14, lineHeight: 1.8,
                      boxShadow: "0 1px 2px rgba(0,0,0,.03)",
                    }}
                  >
                    {m.parts?.map((p, i) =>
                      p.isCite ? (
                        <span
                          key={i}
                          onClick={() => p.citeId && pickCite(p.citeId)}
                          style={{
                            display: "inline-flex", alignItems: "center", justifyContent: "center",
                            minWidth: 17, height: 17, padding: "0 3px", margin: "0 3px", borderRadius: 4,
                            background: p.bg, color: p.fg, fontSize: 11, fontWeight: 600,
                            cursor: "pointer", verticalAlign: 2, userSelect: "none",
                          }}
                        >
                          {p.n}
                        </span>
                      ) : (
                        <span key={i} style={{ whiteSpace: "pre-wrap" }}>{p.text}</span>
                      ),
                    )}
                  </div>
                </div>

                {/* 可信度页脚 */}
                <div style={{ marginLeft: 40, display: "flex", flexDirection: "column", gap: 8 }}>
                  {m.isFallback && (
                    <div
                      style={{
                        border: "1px solid #ffe58f", background: "#fffbe6", borderRadius: 10,
                        padding: "12px 14px", display: "flex", flexDirection: "column", gap: 9,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span
                          style={{
                            width: 20, height: 20, flex: "none", borderRadius: 5, background: "#faad14", color: "#fff",
                            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700,
                          }}
                        >
                          !
                        </span>
                        <span style={{ fontSize: 13, fontWeight: 600, color: "#874d00" }}>
                          未在知识库中找到匹配内容 · 已兜底回复
                        </span>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        {m.fbReasons.map((fr, i) => (
                          <div key={i} style={{ display: "flex", gap: 8, fontSize: 12, lineHeight: 1.6 }}>
                            <span style={{ flex: "none", color: "#d48806", fontWeight: 600, minWidth: 56 }}>{fr.k}</span>
                            <span style={{ color: "rgba(0,0,0,.6)" }}>{fr.v}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {m.showTrust && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                      <div
                        style={{
                          display: "inline-flex", alignItems: "center", gap: 6, height: 26, padding: "0 11px",
                          borderRadius: 13, background: m.confBg, border: `1px solid ${m.confBd}`,
                        }}
                      >
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: m.confColor }} />
                        <span style={{ fontSize: 12, fontWeight: 600, color: m.confColor }}>
                          可信度 {m.confLabel} · {m.confPct}%
                        </span>
                      </div>
                      <div
                        style={{
                          display: "inline-flex", alignItems: "center", gap: 6, height: 26, padding: "0 11px",
                          borderRadius: 13, background: "#fff", border: "1px solid #f0f0f0",
                        }}
                      >
                        <span style={{ fontSize: 12, fontWeight: 700, color: m.coverColor }}>{m.coverIcon}</span>
                        <span style={{ fontSize: 12, color: "rgba(0,0,0,.7)" }}>{m.coverLabel}</span>
                        <span style={{ fontSize: 12, color: "rgba(0,0,0,.35)" }}>· {m.coverSub}</span>
                      </div>
                    </div>
                  )}

                  {m.showLow && (
                    <div
                      style={{
                        display: "flex", gap: 8, alignItems: "flex-start", padding: "9px 12px", borderRadius: 8,
                        background: "#fff7e6", border: "1px solid #ffd591",
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
                      onClick={() => onCopy(m.key, m.plain)}
                      style={{
                        display: "inline-flex", alignItems: "center", gap: 5, height: 28, padding: "0 9px",
                        borderRadius: 6, fontSize: 12, color: "rgba(0,0,0,.5)", cursor: "pointer", userSelect: "none",
                      }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                      {m.copied ? (
                        <span style={{ color: "#52c41a" }}>已复制</span>
                      ) : (
                        <span>复制</span>
                      )}
                    </div>
                    <div
                      onClick={() => onUp(m.key)}
                      style={{
                        display: "inline-flex", alignItems: "center", gap: 5, height: 28, padding: "0 9px",
                        borderRadius: 6, fontSize: 12, cursor: "pointer", userSelect: "none",
                        color: m.upActive ? "#1677ff" : "rgba(0,0,0,.5)",
                        background: m.upActive ? "#e6f4ff" : "transparent",
                      }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
                      </svg>
                      <span>有帮助</span>
                    </div>
                    <div
                      onClick={() => onDown(m.key)}
                      style={{
                        display: "inline-flex", alignItems: "center", gap: 5, height: 28, padding: "0 9px",
                        borderRadius: 6, fontSize: 12, cursor: "pointer", userSelect: "none",
                        color: m.downActive ? "#ff4d4f" : "rgba(0,0,0,.5)",
                        background: m.downActive ? "#fff2f0" : "transparent",
                      }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" />
                      </svg>
                      <span>不准确</span>
                    </div>
                    <div style={{ width: 1, height: 14, background: "#e8e8e8", margin: "0 6px" }} />
                    {m.handoffDone ? (
                      <div
                        style={{
                          display: "inline-flex", alignItems: "center", gap: 6, height: 28, padding: "0 10px",
                          fontSize: 12, color: "#52c41a",
                        }}
                      >
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#52c41a" }} />
                        已转接人工，客服将尽快接入
                      </div>
                    ) : (
                      <div
                        onClick={() => onHandoff(m.key)}
                        style={{
                          display: "inline-flex", alignItems: "center", gap: 5, height: 28, padding: "0 12px",
                          borderRadius: 6, fontSize: 12, fontWeight: 500, color: "#1677ff",
                          border: "1px solid #91caff", background: "#fff", cursor: "pointer", userSelect: "none",
                        }}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                          <circle cx="12" cy="7" r="4" />
                        </svg>
                        转人工
                      </div>
                    )}
                  </div>

                  {m.showFbNote && (
                    <div style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>
                      已记录您的反馈，我们会用于优化该 Agent 的回答质量。
                    </div>
                  )}
                </div>
              </div>
            ),
          )}

          {typing && (
            <div style={{ display: "flex", gap: 10 }}>
              <div
                style={{
                  width: 30, height: 30, flex: "none", borderRadius: 8, background: agent.color, color: "#fff",
                  display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600,
                }}
              >
                {agent.name[0]}
              </div>
              <div
                style={{
                  background: "#fff", border: "1px solid #f0f0f0", padding: "14px 16px",
                  borderRadius: "2px 10px 10px 10px", display: "flex", gap: 5, alignItems: "center",
                }}
              >
                {[0, 0.2, 0.4].map((d) => (
                  <div
                    key={d}
                    style={{
                      width: 6, height: 6, borderRadius: "50%", background: "#1677ff",
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
              display: "flex", gap: 10, alignItems: "flex-end", border: "1px solid #d9d9d9",
              borderRadius: 10, padding: "10px 12px",
            }}
          >
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onComposerKey}
              placeholder="输入您的问题，Enter 发送…"
              style={{
                flex: 1, border: "none", outline: "none", resize: "none", fontSize: 14,
                lineHeight: 1.6, height: 44, padding: 0, fontFamily: "inherit",
              }}
            />
            <button
              type="button"
              onClick={send}
              style={{
                flex: "none", height: 32, padding: "0 16px", borderRadius: 6, background: sendBg, color: "#fff",
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13,
                cursor: "pointer", border: "none",
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
            width: 340, flex: "none", background: "#fff", display: "flex", flexDirection: "column", minHeight: 0,
          }}
        >
          <div
            style={{
              height: 56, flex: "none", borderBottom: "1px solid #f0f0f0", display: "flex",
              alignItems: "center", justifyContent: "space-between", padding: "0 16px",
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600 }}>引用原文</div>
            <div
              onClick={() => setRightOpen(false)}
              style={{
                fontSize: 16, color: "rgba(0,0,0,.45)", cursor: "pointer", width: 24, height: 24,
                display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 4,
              }}
            >
              ×
            </div>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 16, minHeight: 0 }}>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginBottom: 8 }}>
              本会话命中知识 · {citeList.length} 条
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
              {citeList.map((ct) => (
                <div
                  key={ct.id}
                  onClick={() => setCiteId(ct.id)}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 6,
                    border: `1px solid ${ct.bd}`, background: ct.bg, cursor: "pointer",
                  }}
                >
                  <span
                    style={{
                      flex: "none", minWidth: 16, height: 16, padding: "0 3px", borderRadius: 4,
                      background: ct.nBg, color: ct.nFg, fontSize: 11, fontWeight: 600,
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                    }}
                  >
                    {ct.n}
                  </span>
                  <span
                    style={{
                      fontSize: 12, color: "rgba(0,0,0,.65)", whiteSpace: "nowrap",
                      overflow: "hidden", textOverflow: "ellipsis",
                    }}
                  >
                    {ct.sec}
                  </span>
                  <span style={{ flex: "none", marginLeft: "auto", fontSize: 11, color: "rgba(0,0,0,.35)" }}>
                    {ct.score}
                  </span>
                </div>
              ))}
            </div>
            {cite ? (
              <div style={{ border: "1px solid #f0f0f0", borderRadius: 8, overflow: "hidden" }}>
                <div style={{ padding: "12px 14px", background: "#fafafa", borderBottom: "1px solid #f0f0f0" }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>《{cite.doc}》</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <span
                      style={{
                        fontSize: 11, lineHeight: "18px", padding: "0 6px", borderRadius: 4,
                        background: "#e6f4ff", color: "#1677ff", border: "1px solid #91caff",
                      }}
                    >
                      {cite.kb}
                    </span>
                    <span
                      style={{
                        fontSize: 11, lineHeight: "18px", padding: "0 6px", borderRadius: 4,
                        background: "#f6ffed", color: "#52c41a", border: "1px solid #b7eb8f",
                      }}
                    >
                      相似度 {cite.score}
                    </span>
                    <span style={{ fontSize: 11, lineHeight: "18px", color: "rgba(0,0,0,.35)" }}>
                      更新于 {cite.updated}
                    </span>
                  </div>
                </div>
                <div style={{ padding: 14 }}>
                  <div style={{ fontSize: 12, color: "rgba(0,0,0,.35)", lineHeight: 1.8, marginBottom: 10 }}>
                    {cite.before}
                  </div>
                  <div
                    style={{
                      borderLeft: "3px solid #1677ff", background: "#e6f4ff", borderRadius: "0 6px 6px 0",
                      padding: "10px 12px",
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 600, color: "#1677ff", marginBottom: 4 }}>{cite.sec}</div>
                    <div style={{ fontSize: 13, lineHeight: 1.9 }}>{cite.text}</div>
                  </div>
                  <div style={{ fontSize: 12, color: "rgba(0,0,0,.35)", lineHeight: 1.8, marginTop: 10 }}>
                    {cite.after}
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ padding: "40px 20px", textAlign: "center", color: "rgba(0,0,0,.3)", fontSize: 13, lineHeight: 1.8 }}>
                点击回答中的{" "}
                <span
                  style={{
                    display: "inline-flex", minWidth: 16, height: 16, borderRadius: 4, background: "#e6f4ff",
                    color: "#1677ff", fontSize: 11, fontWeight: 600, alignItems: "center", justifyContent: "center",
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
