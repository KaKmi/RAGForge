import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "./config.schema";
import type { ProcessRole } from "./process-role";

@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  get nodeEnv(): Env["NODE_ENV"] {
    return this.config.get("NODE_ENV", { infer: true });
  }
  get port(): number {
    return this.config.get("PORT", { infer: true });
  }
  get databaseUrl(): string {
    return this.config.get("DATABASE_URL", { infer: true });
  }
  get clickHouseUrl(): string {
    return this.config.get("CLICKHOUSE_URL", { infer: true });
  }
  get clickHouseDatabase(): string {
    return this.config.get("CLICKHOUSE_DATABASE", { infer: true });
  }
  get clickHouseUsername(): string {
    return this.config.get("CLICKHOUSE_USERNAME", { infer: true });
  }
  get clickHousePassword(): string {
    return this.config.get("CLICKHOUSE_PASSWORD", { infer: true });
  }
  get otelExporterOtlpEndpoint(): string | undefined {
    return this.config.get("OTEL_EXPORTER_OTLP_ENDPOINT", { infer: true });
  }
  get jwtSecret(): string {
    return this.config.get("JWT_SECRET", { infer: true });
  }
  get jwtExpiresIn(): string {
    return this.config.get("JWT_EXPIRES_IN", { infer: true });
  }
  get modelApiKeyEncryptionKey(): string {
    return this.config.get("MODEL_API_KEY_ENCRYPTION_KEY", { infer: true });
  }
  get blobStorePath(): string {
    return this.config.get("BLOB_STORE_PATH", { infer: true });
  }
  get ingestionEmbedBatchSize(): number {
    return this.config.get("INGESTION_EMBED_BATCH_SIZE", { infer: true });
  }
  get processingProfilesEnabled(): boolean {
    return this.config.get("PROCESSING_PROFILES_ENABLED", { infer: true });
  }
  /** 离线评测单用例编排超时（默认 120s；口径与偏离理由见 config.schema.ts 的注释）。 */
  get evalRunCaseTimeoutMs(): number {
    return this.config.get("EVAL_RUN_CASE_TIMEOUT_MS", { infer: true });
  }
  /** 进程角色（019）：api|worker|all，默认 all。QueueModule 的消费门控经此读取。 */
  get processRole(): ProcessRole {
    return this.config.get("PROCESS_ROLE", { infer: true });
  }
  /** E-W1 冷启动回看窗口（小时，默认 24 = 原行为；0=从现在起，-1=全部历史）。见 config.schema.ts。 */
  get onlineEvalBackfillWindowHours(): number {
    return this.config.get("ONLINE_EVAL_BACKFILL_WINDOW_HOURS", { infer: true });
  }
  /** 候选账本保留天数（按 trace 发生时间，默认 30 = 屏1 最长窗口）。 */
  get onlineEvalLedgerRetentionDays(): number {
    return this.config.get("ONLINE_EVAL_LEDGER_RETENTION_DAYS", { infer: true });
  }
  /** ReleaseCheck 第二段（真实冒烟采样）是否启用，默认关——理由见 config.schema.ts。 */
  get releaseCheckSamplingEnabled(): boolean {
    return this.config.get("RELEASE_CHECK_SAMPLING_ENABLED", { infer: true });
  }
}
