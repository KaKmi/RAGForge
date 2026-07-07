import { z } from "zod";

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
});
export type Env = z.infer<typeof envSchema>;
