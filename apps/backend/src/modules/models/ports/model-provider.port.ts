import type { ModelProtocol, ModelType } from "@codecrush/contracts";

// 端口归 models 域（003:101）。终态为 001:95 chat()/embed()/rerank()，
// M3 只需连通性测试；M4/M8 按需加必选方法（非破坏扩展，diff D5）。
// (type, protocol) 是请求构造的路由键；params 为按类型的默认调用参数。
export interface ModelCallConfig {
  type: ModelType;
  protocol: ModelProtocol;
  name: string;
  baseUrl: string;
  apiKey: string;
  deploymentId?: string;
  params?: Record<string, string>;
}

export interface TestModelResult {
  ok: boolean;
  latencyMs?: number;
  statusCode?: number;
  error?: string;
}

export interface EmbedResult {
  vectors: number[][];
}

export interface RerankResult {
  results: { index: number; score: number }[];
}

export interface ModelProviderPort {
  testConnection(config: ModelCallConfig): Promise<TestModelResult>;
  embed(config: ModelCallConfig, texts: string[]): Promise<EmbedResult>;
  rerank(
    config: ModelCallConfig,
    query: string,
    documents: string[],
    topN?: number,
  ): Promise<RerankResult>;
}
