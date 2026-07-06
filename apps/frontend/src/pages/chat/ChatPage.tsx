import { useEffect, useRef, useState } from "react";
import { Button, Input } from "antd";
import type { ChatCitation, Message } from "@codecrush/contracts";
import { ChatLayout } from "../../app/ChatLayout";
import { openChatStream } from "../../api/sse";
import { MOCK_CONVERSATIONS, MOCK_CITATIONS, MOCK_MESSAGES } from "../../mocks/conversations";

const AGENT_ID = "aftersale";
const CONV_ID = "c1";

/**
 * C 端问答页：三栏（会话列表 + 消息流 + 引用面板）。
 * M2：发送消息走 openChatStream() 消费后端 mock SSE 流（token → citation → done）。
 * M8 接真实 RAG 编排后同此模式。
 */
export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>(MOCK_MESSAGES);
  const [citations, setCitations] = useState<ChatCitation[]>(MOCK_CITATIONS);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const acRef = useRef<AbortController | null>(null);

  // 卸载时中断进行中的流，避免 setState on unmounted
  useEffect(() => {
    return () => {
      acRef.current?.abort();
    };
  }, []);

  const send = async () => {
    const query = input.trim();
    if (!query || streaming) return;
    setInput("");
    setError(null);

    const now = Date.now();
    const userMsg: Message = { id: `u${now}`, convId: CONV_ID, role: "user", content: query };
    const assistantId = `a${now}`;
    const assistantMsg: Message = {
      id: assistantId,
      convId: CONV_ID,
      role: "assistant",
      content: "",
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setCitations([]);
    setStreaming(true);

    const ac = new AbortController();
    acRef.current = ac;
    try {
      let acc = "";
      const newCitations: ChatCitation[] = [];
      for await (const e of openChatStream({ agentId: AGENT_ID, query }, ac.signal)) {
        if (e.type === "token") {
          acc += e.delta;
          const next = acc;
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: next } : m)),
          );
        } else if (e.type === "citation") {
          newCitations.push(e.citation);
          setCitations([...newCitations]);
        } else if (e.type === "done") {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, traceId: e.traceId, confidence: e.confidence }
                : m,
            ),
          );
        } else if (e.type === "error") {
          setError(e.message);
        }
      }
    } catch (e) {
      if (ac.signal.aborted) return; // 卸载或主动取消，静默
      setError(e instanceof Error ? e.message : "流式响应失败");
    } finally {
      setStreaming(false);
      acRef.current = null;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <ChatLayout
      conversations={
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {MOCK_CONVERSATIONS.map((c) => (
            <li
              key={c.id}
              style={{ padding: "8px 12px", borderBottom: "1px solid #f0f0f0" }}
            >
              {c.title}
            </li>
          ))}
        </ul>
      }
      messages={
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <div style={{ flex: 1, overflow: "auto" }}>
            {messages.map((m) => (
              <div
                key={m.id}
                style={{ marginBottom: 8, textAlign: m.role === "user" ? "right" : "left" }}
              >
                <span
                  style={{
                    display: "inline-block",
                    background: m.role === "user" ? "#e6f4ff" : "#f0f0f0",
                    padding: "6px 12px",
                    borderRadius: 6,
                    maxWidth: "80%",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {m.content}
                  {m.role === "assistant" && m.confidence !== undefined && (
                    <span style={{ marginLeft: 8, color: "#999", fontSize: 12 }}>
                      置信度 {Math.round(m.confidence * 100)}%
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
          {error && <div style={{ color: "#ff4d4f", marginBottom: 8 }}>{error}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <Input.TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="输入问题，Enter 发送 / Shift+Enter 换行"
              autoSize={{ minRows: 1, maxRows: 4 }}
              disabled={streaming}
            />
            <Button type="primary" onClick={send} loading={streaming} disabled={!input.trim()}>
              发送
            </Button>
          </div>
        </div>
      }
      citations={
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {citations.map((c, i) => (
            <li
              key={i}
              style={{ padding: "8px 12px", borderBottom: "1px solid #f0f0f0" }}
            >
              [{c.n}] {c.doc} · {c.section}（{c.score}）
            </li>
          ))}
        </ul>
      }
    />
  );
}
