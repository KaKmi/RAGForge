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
  /**
   * E-W1 在线评测**冷启动回看窗口**（小时）——只在 `eval_watermarks` 那行**第一次被创建**时
   * 起作用：游标播种在 `now - N 小时`，更早的 trace 从此**永不进候选集**（`listCandidates`
   * 用严格元组游标只往前看）。
   *
   * 默认 24 = `017:26`「首次启用最多回看 24 小时」的原行为，**不设此变量的部署零变化**。
   * `0` = 只评此后的新问答；`-1` = 回看全部历史。
   *
   * ⚠️ 该窗口是**一次性**的：`onConflictDoNothing` 保护重启（保住原游标），但保护不了**诞生**。
   * 行建好之后改这个值不会有任何效果——要重新播种必须先删那行。
   * ⚠️ `-1` 不解除 `dailyCap`（默认 500/天）：历史多时会分多天评完，而非一次灌爆预算。
   *
   * 之所以要可配：24 这个值原先**不可见也不可配**，而它一声不响吃掉的历史在屏1 上曾被
   * 显示成「可评测」（018 §12 缺口 20 的真因，该缺口原把成因误判为抽样）。
   */
  ONLINE_EVAL_BACKFILL_WINDOW_HOURS: z.coerce.number().int().min(-1).default(24),
  /**
   * `eval_candidate_ledger` 的保留天数（按 trace 发生时间）。默认 30 = 屏1 最长窗口，
   * 更旧的账本行没有读者。
   *
   * 容量：017 设计上限 ≤10 QPS，最坏每天约 86 万行 ⇒ 30 天约 2600 万行。单表能扛，
   * 但要靠 `trace_start_time` 索引 + 本清理，两者缺一不可。真实流量更高时下调此值。
   */
  ONLINE_EVAL_LEDGER_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  // M4.1 文档处理 Profile 特性开关：默认开；置 "false" 回退 legacy chunkTemplate 入库路径
  // （不建 Run、payload 无 processingRunId），供灰度/回滚。
  PROCESSING_PROFILES_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  /**
   * M7b ReleaseCheck 第二段（真实冒烟采样）开关：默认 **关**（用户 2026-07-19 决定）。
   *
   * 上线校验分两段：①静态门禁（同步，毫秒级，不通过直接 422）②真实冒烟采样（异步）。
   * 第二段拿 `release-check.samples.ts` 的固定样例真调模型：rewrite/intent 各 10 条、
   * reply 1 条 ⇒ **21 次真实 LLM 调用**，实测耗时 1:52～2:00。
   *
   * 关掉的理由不是「慢」而是「样例已失效」：那 10 条是电商客服问题（怎么退货/运费怎么算…），
   * 源于 M7b 时期「无评测集、Postgres 不存真实用户问题」的权宜之计（见 samples.ts 头注释）。
   * M11 评测集已交付（E-W2a），该前提不再成立——对非电商应用，这 21 次调用既慢又验证不到
   * 真实的东西。样例该改成什么（取自评测集 / 应用自配 / 领域中性）是待定的产品决策。
   *
   * 置 "true" 恢复第二段。**关闭期间检查仍会产出一条 `SAMPLING_SKIPPED` warning**，
   * 使「passed」不至于悄悄代表更弱的保证。
   */
  RELEASE_CHECK_SAMPLING_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
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
