import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Spin } from "antd";
import { AdminLayout } from "./AdminLayout";
import { AuthGuard } from "./AuthGuard";

// React.lazy 分包：15 屏各自独立 chunk，减小首屏体积。
const LoginPage = lazy(() => import("../pages/login/LoginPage"));
const ChatPage = lazy(() => import("../pages/chat/ChatPage"));
const StartPage = lazy(() => import("../pages/admin/StartPage"));
const DashboardPage = lazy(() => import("../pages/admin/DashboardPage"));
const AgentsPage = lazy(() => import("../pages/admin/AgentsPage"));
const ApplicationsPage = lazy(() => import("../pages/admin/ApplicationsPage"));
const ApplicationDetailPage = lazy(() => import("../pages/admin/ApplicationDetailPage"));
const KnowledgeBasesPage = lazy(() => import("../pages/admin/KnowledgeBasesPage"));
const DocumentsPage = lazy(() => import("../pages/admin/DocumentsPage"));
const ChunksPage = lazy(() => import("../pages/admin/ChunksPage"));
const RetrievalTestPage = lazy(() => import("../pages/admin/RetrievalTestPage"));
const PromptsPage = lazy(() => import("../pages/admin/PromptsPage"));
const PromptDetailPage = lazy(() => import("../pages/admin/PromptDetailPage"));
const GapsPage = lazy(() => import("../pages/admin/GapsPage"));
const EvalSetsPage = lazy(() => import("../pages/admin/EvalSetsPage"));
const EvalsPage = lazy(() => import("../pages/admin/EvalsPage"));
const TracesPage = lazy(() => import("../pages/admin/TracesPage"));
const TraceDetailPage = lazy(() => import("../pages/admin/TraceDetailPage"));
const ModelsPage = lazy(() => import("../pages/admin/ModelsPage"));

const Fallback = (
  <div style={{ padding: 24, textAlign: "center" }}>
    <Spin />
  </div>
);

/**
 * 路由根：14 条 admin 路由（覆盖 15 屏）+ /login + /chat + 通配重定向。
 * 路由表对齐 docs/design/006-m2-app-shell-skeleton.md。
 * admin 子路由与 /chat 均懒加载；/chat 由 ChatPage 内联三栏（Agent/会话 + 消息流 + 引用原文）。
 */
export function App() {
  return (
    <Suspense fallback={Fallback}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {/* M8 T4：一个 bot 一个 URL——:agentId 为 slug 或 applicationId，直传 resolvePublic/getApplications。
            /chat 不套 AdminLayout，故在此用 100vh 容器锁整页高（ChatPage 内层 height:100% 依赖之）。 */}
        <Route
          path="/chat/:agentId"
          element={
            <AuthGuard>
              <div style={{ height: "100vh" }}>
                <ChatPage />
              </div>
            </AuthGuard>
          }
        />
        {/* 裸 /chat 无 agent 落点 → 重定向管理台（与通配一致） */}
        <Route path="/chat" element={<Navigate to="/admin" replace />} />
        <Route
          path="/admin"
          element={
            <AuthGuard>
              <AdminLayout />
            </AuthGuard>
          }
        >
          <Route index element={<StartPage />} />
          <Route path="dashboard" element={<DashboardPage />} />
          {/* 旧 agents 路由保留可直达（不入导航，M7b 删除） */}
          <Route path="agents" element={<AgentsPage />} />
          <Route path="applications" element={<ApplicationsPage />} />
          <Route path="applications/:appId" element={<ApplicationDetailPage />} />
          <Route path="knowledge-bases" element={<KnowledgeBasesPage />} />
          <Route path="knowledge-bases/:kbId/documents" element={<DocumentsPage />} />
          <Route path="knowledge-bases/:kbId/documents/:docId/chunks" element={<ChunksPage />} />
          <Route path="retrieval-test" element={<RetrievalTestPage />} />
          <Route path="prompts" element={<PromptsPage />} />
          <Route path="prompts/:promptId" element={<PromptDetailPage />} />
          <Route path="gaps" element={<GapsPage />} />
          <Route path="evalsets" element={<EvalSetsPage />} />
          <Route path="evaluations" element={<EvalsPage />} />
          <Route path="evaluations/:reportId" element={<EvalsPage />} />
          <Route path="traces" element={<TracesPage />} />
          <Route path="traces/:traceId" element={<TraceDetailPage />} />
          <Route path="models" element={<ModelsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </Suspense>
  );
}
