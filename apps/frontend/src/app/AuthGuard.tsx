import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";

interface AuthGuardProps {
  children: ReactNode;
}

/**
 * 登录守卫：localStorage 无 token 则重定向 /login。
 * M1（005）的 JWT 在前端落 localStorage；M2 只做存在性检查，
 * 401 由 api/sse.ts（Story 6）在 fetch 响应层统一处理。
 */
export function AuthGuard({ children }: AuthGuardProps) {
  const token = localStorage.getItem("token");
  if (!token) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
