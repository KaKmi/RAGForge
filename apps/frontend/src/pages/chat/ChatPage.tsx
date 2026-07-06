import { List } from "antd";
import { ChatLayout } from "../../app/ChatLayout";
import { MOCK_CONVERSATIONS, MOCK_CITATIONS, MOCK_MESSAGES } from "../../mocks/conversations";

/**
 * C 端问答页：三栏（会话列表 + 消息流 + 引用面板），M2 用 mock 数据。
 * M8 接真实 /api/chat SSE 流后，messages 改为流式渲染。
 */
export default function ChatPage() {
  return (
    <ChatLayout
      conversations={
        <List
          size="small"
          dataSource={MOCK_CONVERSATIONS}
          renderItem={(c) => <List.Item>{c.title}</List.Item>}
        />
      }
      messages={
        <div>
          {MOCK_MESSAGES.map((m) => (
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
                }}
              >
                {m.content}
              </span>
            </div>
          ))}
        </div>
      }
      citations={
        <List
          size="small"
          dataSource={MOCK_CITATIONS}
          renderItem={(c) => (
            <List.Item>
              [{c.n}] {c.doc} · {c.section}（{c.score}）
            </List.Item>
          )}
        />
      }
    />
  );
}
