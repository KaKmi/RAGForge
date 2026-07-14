import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { message, Spin } from "antd";
import type { SessionDetailResponse, TraceStatus } from "@codecrush/contracts";
import { getSession } from "../../api/client";

/**
 * M9 W3：Session 详情——1:1 还原 C 端聊天窗口（该会话在用户侧的真实呈现），
 * 每条回复气泡下方挂 Trace 溯源条，点击下钻到该轮调用链路（原型「Session 详情」屏）。
 */

const AGENT_COLOR = "#1677ff"; // 同 C 端 ChatPage：原型无真实每 Agent 颜色字段，固定主题色
const initialOf = (name: string): string => name.trim().slice(0, 1).toUpperCase() || "A";

const STATUS_TAG: Record<TraceStatus, { label: string; bg: string; c: string; bd: string }> = {
  success: { label: "成功", bg: "#f6ffed", c: "#52c41a", bd: "#b7eb8f" },
  fallback: { label: "兜底", bg: "#fffbe6", c: "#d48806", bd: "#ffe58f" },
  failed: { label: "失败", bg: "#fff2f0", c: "#ff4d4f", bd: "#ffccc7" },
};

const fmtMs = (ms: number): string => (ms >= 1000 ? (ms / 1000).toFixed(2) + "s" : Math.round(ms) + "ms");
const fmtTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
};
const fmtDate = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
};

export default function SessionDetailPage() {
  const { sessionId = "" } = useParams<{ sessionId: string }>();
  const nav = useNavigate();
  const [data, setData] = useState<SessionDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    getSession(sessionId)
      .then((r) => {
        if (live) setData(r);
      })
      .catch((e: unknown) => {
        if (live) message.error(e instanceof Error ? e.message : "加载会话详情失败");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [sessionId]);

  const headBtn: CSSProperties = {
    height: 30,
    padding: "0 12px",
    border: "1px solid #d9d9d9",
    borderRadius: 6,
    background: "#fff",
    display: "flex",
    alignItems: "center",
    fontSize: 13,
    cursor: "pointer",
    width: "fit-content",
  };

  const firstTs = useMemo(() => data?.rounds[0]?.startTime ?? "", [data]);

  if (loading) {
    return (
      <div style={{ padding: 64, textAlign: "center" }}>
        <Spin />
      </div>
    );
  }
  if (!data || data.rounds.length === 0) {
    return (
      <div>
        <div onClick={() => nav("/admin/traces")} style={{ ...headBtn, marginBottom: 16 }}>
          ← 返回列表
        </div>
        <div style={{ padding: 48, textAlign: "center", color: "rgba(0,0,0,.3)", fontSize: 13 }}>
          未找到该会话（可能尚未落库或已过期）
        </div>
      </div>
    );
  }

  const initial = initialOf(data.agentName || "A");

  return (
    <div style={{ maxWidth: 1280, margin: "0 auto", paddingBottom: 32 }}>
      {/* 头部：返回 + sessionId + 用户/轮次 */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14, flexWrap: "wrap" }}>
        <div onClick={() => nav("/admin/traces")} style={headBtn}>
          ← 返回列表
        </div>
        <div style={{ fontSize: 18, fontWeight: 650, color: "#0f172a" }}>会话详情</div>
        <span style={{ fontSize: 12, color: "#64748b", fontFamily: "ui-monospace,Menlo,monospace" }}>{data.sessionId}</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12, marginBottom: 18 }}>
        {[{ label: "应用", value: data.agentName || "—" }, { label: "用户", value: data.userId ?? "未记录" }, { label: "对话轮次", value: `${data.rounds.length} 轮` }, { label: "会话状态", value: data.rounds.some((round) => round.status === "failed") ? "存在失败" : data.rounds.some((round) => round.status === "fallback") ? "包含兜底" : "正常" }].map((item) => <div key={item.label} style={{ background: "#fff", border: "1px solid #e8edf3", borderRadius: 10, padding: "13px 16px", boxShadow: "0 3px 14px rgba(15,23,42,.04)" }}><div style={{ fontSize: 12, color: "#94a3b8" }}>{item.label}</div><div style={{ marginTop: 6, fontSize: 15, fontWeight: 600, color: "#334155", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.value}</div></div>)}
      </div>

      {/* C 端聊天窗口卡 */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 280px", gap: 18, alignItems: "start" }}>
      <div style={{ height: "calc(100vh - 270px)", minHeight: 460, border: "1px solid #e2e8f0", borderRadius: 14, overflow: "hidden", boxShadow: "0 8px 28px rgba(15,23,42,.07)", background: "#f8fafc", display: "flex", flexDirection: "column" }}>
        {/* 顶栏 */}
        <div style={{ height: 64, background: "#fff", borderBottom: "1px solid #e8edf3", display: "flex", alignItems: "center", gap: 12, padding: "0 20px" }}>
          <div style={{ width: 34, height: 34, borderRadius: 9, background: AGENT_COLOR, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 600 }}>{initial}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{data.agentName || "—"}</div>
            <div style={{ fontSize: 11, color: "#52c41a", display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#52c41a" }} />
              在线
            </div>
          </div>
          <div style={{ fontSize: 11, color: "rgba(0,0,0,.3)" }}>AI BOT</div>
        </div>

        {/* 气泡区 */}
        <div style={{ flex: 1, minHeight: 0, padding: "18px 24px", display: "flex", flexDirection: "column", gap: 16, overflowY: "auto" }}>
          {firstTs && (
            <div style={{ textAlign: "center" }}>
              <span style={{ fontSize: 11, color: "rgba(0,0,0,.35)", background: "rgba(0,0,0,.05)", padding: "2px 10px", borderRadius: 10 }}>{fmtDate(firstTs)}</span>
            </div>
          )}
          {data.rounds.map((t) => {
            const st = STATUS_TAG[t.status];
            const time = fmtTime(t.startTime);
            return (
              <div key={t.traceId} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {/* 用户气泡（右） */}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "flex-start" }}>
                  <div style={{ maxWidth: "74%", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                    <div style={{ background: "#95ec69", color: "#1a1a1a", padding: "9px 13px", borderRadius: 8, fontSize: 13.5, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{t.userInput || "—"}</div>
                    <span style={{ fontSize: 10, color: "rgba(0,0,0,.3)" }}>{time}</span>
                  </div>
                  <div style={{ width: 32, height: 32, flex: "none", borderRadius: 8, background: "#c9ced6", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>👤</div>
                </div>

                {/* Bot 气泡（左）+ Trace 溯源条 */}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-start", alignItems: "flex-start" }}>
                  <div style={{ width: 32, height: 32, flex: "none", borderRadius: 8, background: AGENT_COLOR, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 600 }}>{initial}</div>
                  <div style={{ maxWidth: "80%", display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
                    <div style={{ background: "#fff", color: "#1a1a1a", padding: "10px 14px", borderRadius: 8, fontSize: 13.5, lineHeight: 1.7, boxShadow: "0 1px 2px rgba(0,0,0,.04)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{t.output || "—"}</div>
                    {/* 溯源条：观测层，点击下钻到该轮 Trace 详情 */}
                    <div
                      onClick={() => nav(`/admin/traces/${t.traceId}`)}
                      style={{ display: "inline-flex", alignItems: "center", gap: 7, background: "rgba(22,119,255,.06)", border: "1px solid rgba(22,119,255,.15)", borderRadius: 6, padding: "3px 8px", cursor: "pointer" }}
                    >
                      <span style={{ fontSize: 10, lineHeight: "16px", padding: "0 6px", borderRadius: 3, background: st.bg, color: st.c, border: `1px solid ${st.bd}` }}>{st.label}</span>
                      <span style={{ fontSize: 10.5, fontFamily: "ui-monospace,Menlo,monospace", color: "#1677ff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 180 }}>{t.traceId}</span>
                      <span style={{ fontSize: 10.5, color: "rgba(0,0,0,.4)" }}>{fmtMs(t.durationMs)}</span>
                      <span style={{ fontSize: 10.5, color: "#1677ff", flex: "none" }}>链路 →</span>
                    </div>
                    <span style={{ fontSize: 10, color: "rgba(0,0,0,.3)" }}>{time}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* 输入栏（装饰，还原 C 端观感） */}
        <div style={{ height: 52, background: "#fff", borderTop: "1px solid #f0f0f0", display: "flex", alignItems: "center", gap: 10, padding: "0 14px" }}>
          <div style={{ flex: 1, height: 34, background: "#f5f6f8", borderRadius: 8, display: "flex", alignItems: "center", padding: "0 12px", fontSize: 13, color: "rgba(0,0,0,.3)" }}>输入消息…</div>
          <div style={{ width: 60, height: 32, borderRadius: 7, background: "#e6e8eb", color: "rgba(0,0,0,.35)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13 }}>发送</div>
        </div>
      </div>
      <aside style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 18, boxShadow: "0 5px 20px rgba(15,23,42,.04)" }}>
        <div style={{ fontSize: 14, fontWeight: 650, color: "#0f172a", marginBottom: 16 }}>会话概览</div>
        <div style={{ display: "grid", gap: 12 }}>
          {data.rounds.map((round, index) => { const st = STATUS_TAG[round.status]; return <div key={round.traceId} onClick={() => nav(`/admin/traces/${round.traceId}`)} style={{ padding: "11px 12px", border: "1px solid #eef2f7", borderRadius: 9, cursor: "pointer", background: "#fbfdff" }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><span style={{ fontSize: 12, fontWeight: 600, color: "#334155" }}>第 {index + 1} 轮</span><span style={{ fontSize: 11, color: st.c }}>{st.label}</span></div><div style={{ marginTop: 7, color: "#64748b", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{round.userInput || "无问题文本"}</div><div style={{ marginTop: 6, color: "#94a3b8", fontSize: 11 }}>{fmtMs(round.durationMs)} · 查看 Trace →</div></div>; })}
        </div>
      </aside>
      </div>
      <div style={{ textAlign: "center", fontSize: 11, color: "rgba(0,0,0,.35)", marginTop: 12 }}>
        这是该会话在 C 端的真实呈现 · 每条回复下方的溯源条点击可下钻到 Trace 调用链路
      </div>
    </div>
  );
}
