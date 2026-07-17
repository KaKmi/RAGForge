import { z } from "zod";
import { parseProcessRole, type ProcessRole } from "./process-role";

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  CLICKHOUSE_URL: z.string().default("http://localhost:8123"),
  CLICKHOUSE_DATABASE: z.string().default("default"),
  CLICKHOUSE_USERNAME: z.string().default("default"),
  CLICKHOUSE_PASSWORD: z.string().default(""),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default("12h"),
  // 模型 API Key 加密主密钥：32 字节 base64（44 字符），生成：openssl rand -base64 32
  MODEL_API_KEY_ENCRYPTION_KEY: z.string().min(44),
  BLOB_STORE_PATH: z.string().default("./.data/blobs"),
  INGESTION_EMBED_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  /**
   * 离线评测**单用例编排超时**（`eval-runs` worker 专用；在线 chat 不读本项）。
   *
   * **默认 120s，刻意偏离原型 §6「单用例编排超时 30s(同线上熔断)」**（018 §12 缺口 16）：
   * 那个 30s 继承自**在线**熔断，约束的是「人在等」的时长；离线批跑没有人在等。实测
   * （E-W2a QA，4 次真实 run / 2 个应用）30s 下 **100% 用例判超时、一个分都出不来**——
   * 仅 rewrite + intent 两次结构化调用就吃掉 27.7s，整条用例 36~46s。120s ≈ 实测最慢
   * 46.2s 的 2.6 倍余量，保留原型「封顶防失控」的意图，只是不再把正常用例当失控。
   *
   * ⚠️ 这是**判定阈值**，不是墙钟上限（018 §12 缺口 9，peer review 实测）：
   * `runForEvaluation` 的 `timeoutMs` 只决定何时判 `timedOut=true`，实际返回时刻由在途
   * `next()` 自行结束决定（异步生成器 `return()` 无法抢占执行中的 `next()`）。
   * 勿据此值假设一条用例最多耗时这么久——真正的硬中断要等 W2b 把 AbortSignal
   * plumb 进 `ModelProviderPort`。
   *
   * 调大它是**安全网不是解药**：根因是模型的思考 token（018 §12 缺口 17）。
   */
  EVAL_RUN_CASE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  // M4.1 文档处理 Profile 特性开关：默认开；置 "false" 回退 legacy chunkTemplate 入库路径
  // （不建 Run、payload 无 processingRunId），供灰度/回滚。
  PROCESSING_PROFILES_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  // 019：进程角色分流。校验逻辑完全委托 parseProcessRole（全仓唯一校验器，
  // main.ts/tracing.ts 在 DI 前也调它），本字段只是把结果带进 Env 供 AppConfigService 读。
  PROCESS_ROLE: z
    .string()
    .optional()
    .transform((value, ctx): ProcessRole => {
      try {
        return parseProcessRole({ PROCESS_ROLE: value });
      } catch (error) {
        ctx.addIssue({ code: "custom", message: (error as Error).message });
        return z.NEVER;
      }
    }),
});
export type Env = z.infer<typeof envSchema>;
