import { z } from "zod";

export const ModelTypeSchema = z.enum(["llm", "embedding", "rerank"]);
export type ModelType = z.infer<typeof ModelTypeSchema>;

// 协议格式（001「协议格式为路由键」）：平台不绑厂商，只做协议适配。
// (type, protocol) 是运行期请求构造的路由键，Base URL 决定打到谁家。
export const ModelProtocolSchema = z.enum([
  "openai_compat",
  "anthropic",
  "gemini",
  "cohere",
  "jina",
  "dashscope",
  "self_hosted",
]);
export type ModelProtocol = z.infer<typeof ModelProtocolSchema>;

// 合法 (type, protocol) 组合的单一事实源：前端候选渲染与后端校验共用
export const PROTOCOLS_BY_TYPE: Record<ModelType, readonly ModelProtocol[]> = {
  llm: ["openai_compat", "anthropic", "gemini"],
  embedding: ["self_hosted", "openai_compat", "gemini", "cohere", "jina"],
  // rerank 的 openai_compat = /v1/reranks 扁平体（阿里云百炼 compatible-api、其他兼容网关）；
  // dashscope = 原生 text-rerank 形态（input/parameters 包裹，响应 output.results）
  rerank: ["self_hosted", "openai_compat", "cohere", "jina", "dashscope"],
} as const;

/** 组合合法性判定：后端 service 在 PATCH 单改 type/protocol 时结合存量行复用 */
export function isValidProtocol(type: ModelType, protocol: ModelProtocol): boolean {
  return PROTOCOLS_BY_TYPE[type].includes(protocol);
}

const validProtocolForType = (
  data: { type: ModelType; protocol?: ModelProtocol },
  ctx: z.RefinementCtx,
) => {
  if (data.protocol && !isValidProtocol(data.type, data.protocol)) {
    ctx.addIssue({
      code: "custom",
      path: ["protocol"],
      message: `protocol ${data.protocol} 不适用于类型 ${data.type}`,
    });
  }
};

// 读侧：仅掩码，永不含明文 apiKey；role 不持久化（001:81 权威表无此列）
export const ModelProviderSchema = z.object({
  id: z.string().min(1),
  type: ModelTypeSchema,
  protocol: ModelProtocolSchema,
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKeyMasked: z.string(),
  deploymentId: z.string().optional(),
  // 按类型的默认调用参数（llm: temperature/max_tokens；embedding: dimensions/batch_size；
  // rerank: top_n/threshold）。值统一存字符串（原型为自由文本输入），下游消费时解析。
  params: z.record(z.string(), z.string()),
  enabled: z.boolean(),
});
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

export const ModelProviderListResponseSchema = z.array(ModelProviderSchema);
export type ModelProviderListResponse = z.infer<typeof ModelProviderListResponseSchema>;

const CreateModelShape = ModelProviderSchema.omit({
  id: true,
  apiKeyMasked: true,
}).extend({
  apiKey: z.string().min(8),
  params: z.record(z.string(), z.string()).default({}),
});

// 写侧：明文 apiKey（HTTPS 内传输，后端加密落库），enabled 缺省 true（抽屉无开关）
export const CreateModelRequestSchema = CreateModelShape.extend({
  enabled: z.boolean().default(true),
}).superRefine(validProtocolForType);
export type CreateModelRequest = z.infer<typeof CreateModelRequestSchema>;

// PATCH：全可选；apiKey 不传 = 不改。
// 注意不可从 CreateModelRequestSchema.partial() 派生：zod v4 下 .default() 经 partial()
// 解析 {} 仍会注入默认值，空 PATCH 会误改字段——故基于无 default 的形状构造。
// (type, protocol) 组合校验仅在两者同时出现时进行（单改一个由 service 层结合存量行校验）。
export const UpdateModelRequestSchema = ModelProviderSchema.omit({
  id: true,
  apiKeyMasked: true,
})
  .extend({ apiKey: z.string().min(8) })
  .partial()
  .superRefine((data, ctx) => {
    if (data.type && data.protocol) {
      validProtocolForType({ type: data.type, protocol: data.protocol }, ctx);
    }
  });
export type UpdateModelRequest = z.infer<typeof UpdateModelRequestSchema>;

// ad-hoc 连通性测试（抽屉保存前验活，不落库；无 enabled）
export const TestModelRequestSchema = CreateModelShape.omit({ enabled: true }).superRefine(
  validProtocolForType,
);
export type TestModelRequest = z.infer<typeof TestModelRequestSchema>;

// 已存模型的测试 override（编辑抽屉改了配置但未换 key：服务端用存量 key + 抽屉当前配置测试）。
// 不含 apiKey——key 永不下发/回传前端；合并后的 (type, protocol) 合法性由 service 校验。
// 基于 ModelProviderSchema（无 default 字段）构造，规避 partial+default 注入问题。
export const TestModelOverrideSchema = ModelProviderSchema.omit({
  id: true,
  apiKeyMasked: true,
  enabled: true,
})
  .partial()
  .default({}); // 无 body 的 POST /:id/test：undefined → {}（纯存量配置测试）
export type TestModelOverride = z.infer<typeof TestModelOverrideSchema>;

export const TestModelResponseSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative().optional(),
  statusCode: z.number().int().optional(),
  error: z.string().optional(),
});
export type TestModelResponse = z.infer<typeof TestModelResponseSchema>;
