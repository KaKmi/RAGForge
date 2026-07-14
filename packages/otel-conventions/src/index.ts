export const GEN_AI = {
  SYSTEM: "gen_ai.system",
  OPERATION_NAME: "gen_ai.operation.name",
  REQUEST_MODEL: "gen_ai.request.model",
  USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  TOOL_NAME: "gen_ai.tool.name",
  TOOL_CALL_ID: "gen_ai.tool.call.id",
  TOOL_TYPE: "gen_ai.tool.type",
  AGENT_NAME: "gen_ai.agent.name",
  AGENT_ID: "gen_ai.agent.id",
} as const;

export const RAG = {
  RETRIEVAL_TOP_K: "rag.retrieval.top_k",
  RETRIEVAL_TOP_N: "rag.retrieval.top_n",
  RETRIEVAL_THRESHOLD: "rag.retrieval.threshold",
  MULTI_RECALL: "rag.multi",
  CHUNK_SCORES: "rag.chunk.scores",
  CITATION_IDS: "rag.citation.ids",
  // M9：意图路由（落 intent 节点 span，供详情面板显示「意图 → 路由到 X 库」）
  INTENT: "rag.intent",
  ROUTE_KB_NAMES: "rag.route.kb_names",
  COST_USD: "rag.cost.usd",
  PROMPT_VERSION_ID: "rag.prompt.version_id",
  VEC_WEIGHT: "rag.retrieval.vec_weight",
  RERANK_THRESHOLD: "rag.rerank.threshold",
  // 012 §Observability：试运行（预览）调用打标，与正式问答的成功率/延迟统计隔离
  PREVIEW: "rag.preview",
  // M8.0 011 §Observability：NodeRuntime 执行层 span 属性
  NODE_NAME: "rag.node.name",
  PROMPT_CONTRACT_VERSION: "rag.prompt.contract_version",
  VALIDATION_ERROR_CODE: "rag.validation.error_code",
  REPAIR_RETRY_COUNT: "rag.repair.retry_count",
  REPAIR_ATTEMPT_COUNT: "rag.repair.attempt_count",
  REPAIR_ELIGIBLE_COUNT: "rag.repair.eligible_count",
  TTFT_MS: "rag.ttft_ms",
  GENERATION_DURATION_MS: "rag.generation.duration_ms",
  GENERATION_TOKENS_PER_SECOND: "rag.generation.tokens_per_second",
  DEGRADED_KEYWORD_RECALL: "rag.degraded.keyword_recall",
  DEGRADED_RERANK: "rag.degraded.rerank",
  DEGRADED_KEYWORD_RECALL_COUNT: "rag.degraded.keyword_recall.count",
  DEGRADED_RERANK_COUNT: "rag.degraded.rerank.count",
  RETRIEVAL_EXECUTION_COUNT: "rag.retrieval.execution_count",
  KEYWORD_REQUESTED_COUNT: "rag.keyword.requested_count",
  RERANK_REQUESTED_COUNT: "rag.rerank.requested_count",
  QUALITY_CONFIDENCE: "rag.quality.confidence",
  CITATION_COUNT: "rag.citation.count",
  CITATION_COVERAGE: "rag.citation.coverage",
  FALLBACK_USED: "rag.fallback.used",
  STRUCTURED_OUTPUT_MODE: "rag.structured_output.mode",
  // M8 T3：质量信号（供 M9 Badcase 池按布尔筛；四布尔独立可筛，避开 Map(String,String) 数组字符串化）
  QUALITY_LOW_RECALL: "rag.quality.low_recall",
  QUALITY_NO_CITATIONS: "rag.quality.no_citations",
  QUALITY_REFUSAL: "rag.quality.refusal",
  QUALITY_TIMEOUT: "rag.quality.timeout",
} as const;

export const OTEL_OPERATIONS = {
  CHAT: "chat",
  TEXT_COMPLETION: "text_completion",
  EMBEDDINGS: "embeddings",
  EXECUTE_TOOL: "execute_tool",
  INVOKE_AGENT: "invoke_agent",
  CREATE_AGENT: "create_agent",
  RETRIEVE: "retrieve",
  RERANK: "rerank",
  KEYWORD_RECALL: "keyword_recall",
  HITS: "hits",
  CUSTOM: "custom",
} as const;

export const CODECRUSH_SPAN_KIND = {
  CHAIN: "chain",
  LLM: "llm",
  EMBEDDINGS: "embeddings",
  RETRIEVAL: "retrieval",
  RERANK: "rerank",
  TOOL: "tool",
  AGENT: "agent",
  EVENT: "event",
  CUSTOM: "custom",
} as const;

// M8 T3：通用 trace IO（004 Invariant 6「SDK 工作负载通用」——输入/输出是通用 trace 概念、
// 非 RAG 专属，与既有 codecrush.span.kind 同命名空间；未来 agent/tool 调用同样用它）。
export const CODECRUSH_IO = {
  INPUT: "codecrush.io.input",
  OUTPUT: "codecrush.io.output",
} as const;
// 落 ClickHouse 前脱敏后打标（RedactingSpanExporter 置位）
export const CODECRUSH_REDACTED = "codecrush.redacted";

// M9 W1：会话分组键与终端用户键（OTel 通用语义约定；前后端 + ClickHouse VIEW 共用，避免键名漂移）
export const SESSION_ID = "session.id";
export const ENDUSER_ID = "enduser.id";
