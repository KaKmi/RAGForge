import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "./config.schema";

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
}
