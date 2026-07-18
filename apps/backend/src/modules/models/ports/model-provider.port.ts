import type { ModelProtocol, ModelType } from "@codecrush/contracts";

// 端口归 models 域（003:101）。M8.0：chat() 从 012 的简化两消息签名升级为
// 两层消息（system/user）+ 结构化输出（011 Design §2），新增 chatStream()（非破坏
// 扩展原则下的唯一一次签名 breaking change——旧签名的唯一调用方
// prompts.service.tryRun() 随本任务一起切到 node-runtime，不留兼容层）。
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

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface StructuredOutputSpec {
  name: string;
  /** JSON Schema，由 node-runtime 用 Zod 4 原生 z.toJSONSchema(outputSchema) 生成 */
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface ChatOptions {
  /** 覆盖模型存量默认 temperature，仅影响本次调用 */
  temperature?: number;
  maxTokens?: number;
  structuredOutput?: StructuredOutputSpec;
  /**
   * E-W2b F1：外部中止信号（加性可选，省略 → 行为与今日逐字节一致）。与内部固定超时
   * controller 合并（`AbortSignal.any`）——外部中止时错误文案说「被中止」而非「超时」。
   */
  signal?: AbortSignal;
}

/** embed/rerank 的加性可选项（F1）。 */
export interface ModelCallOptions {
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  raw?: unknown;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ChatStreamChunk {
  delta?: string;
  done?: boolean;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
}

export interface RerankResult {
  results: { index: number; score: number }[];
}

export interface ModelProviderPort {
  testConnection(config: ModelCallConfig): Promise<TestModelResult>;
  chat(config: ModelCallConfig, messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
  chatStream(
    config: ModelCallConfig,
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): AsyncIterable<ChatStreamChunk>;
  embed(config: ModelCallConfig, texts: string[], opts?: ModelCallOptions): Promise<EmbedResult>;
  rerank(
    config: ModelCallConfig,
    query: string,
    documents: string[],
    topN?: number,
    opts?: ModelCallOptions,
  ): Promise<RerankResult>;
}
