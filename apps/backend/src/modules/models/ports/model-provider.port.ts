import type { ModelType } from "@codecrush/contracts";

// 端口归 models 域（003:101）。终态为 001:95 chat()/embed()/rerank()，
// M3 只需连通性测试；M4/M8 按需加必选方法（非破坏扩展，diff D5）。
export interface ModelCallConfig {
  type: ModelType;
  provider: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  deploymentId?: string;
}

export interface TestModelResult {
  ok: boolean;
  latencyMs?: number;
  statusCode?: number;
  error?: string;
}

export interface ModelProviderPort {
  testConnection(config: ModelCallConfig): Promise<TestModelResult>;
}
