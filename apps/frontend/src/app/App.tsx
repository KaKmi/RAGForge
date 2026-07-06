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
const KnowledgeBasesPage = lazy(() => import("../pages/admin/KnowledgeBasesPage"));
const DocumentsPage = lazy(() => import("../pages/admin/DocumentsPage"));
const ChunksPage = lazy(() => import("../pages/admin/ChunksPage"));
const RetrievalTestPage = lazy(() => import("../pages/admin/RetrievalTestPage"));
const PromptsPage = lazy(() => import("../pages/admin/PromptsPage"));
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
 * admin 子路由与 /chat 均懒加载；/chat 由 ChatPage 渲染三栏 ChatLayout。
 */
export function App() {
  return (
    <Suspense fallback={Fallback}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/chat"
          element={
            <AuthGuard>
              <ChatPage />
            </AuthGuard>
          }
        />
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
          <Route path="agents" element={<AgentsPage />} />
          <Route path="knowledge-bases" element={<KnowledgeBasesPage />} />
          <Route path="knowledge-bases/:kbId/documents" element={<DocumentsPage />} />
          <Route path="knowledge-bases/:kbId/documents/:docId/chunks" element={<ChunksPage />} />
          <Route path="retrieval-test" element={<RetrievalTestPage />} />
          <Route path="prompts" element={<PromptsPage />} />
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
