import type { ReactNode } from "react";
import { Layout } from "antd";

const { Sider, Content } = Layout;

interface ChatLayoutProps {
  /** 左栏：会话列表内容 */
  conversations?: ReactNode;
  /** 中栏：消息流内容 */
  messages?: ReactNode;
  /** 右栏：引用面板内容 */
  citations?: ReactNode;
}

/**
 * C 端问答 shell：三栏（会话列表 + 聊天 + 引用面板）。
 * 列头常驻渲染（便于布局识别），内容由 ChatPage 通过 slot 注入。
 * M8 接真实 SSE 流时，messages slot 改为流式渲染。
 */
export function ChatLayout({ conversations, messages, citations }: ChatLayoutProps) {
  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider width={260} theme="light" style={{ background: "#fff" }}>
        <div style={colHeaderStyle}>会话列表</div>
        <div style={{ padding: 8, overflow: "auto" }}>{conversations}</div>
      </Sider>
      <Content style={{ padding: 16, background: "#fff" }}>
        <div style={{ ...colHeaderStyle, borderBottom: "1px solid #f0f0f0", marginBottom: 12 }}>聊天</div>
        {messages}
      </Content>
      <Sider width={360} theme="light" style={{ background: "#fff" }}>
        <div style={colHeaderStyle}>引用</div>
        <div style={{ padding: 8, overflow: "auto" }}>{citations}</div>
      </Sider>
    </Layout>
  );
}

const colHeaderStyle: React.CSSProperties = {
  padding: 16,
  fontWeight: 600,
  borderBottom: "1px solid #f0f0f0",
};
