import { Injectable } from "@nestjs/common";
import type { ModelType } from "@codecrush/contracts";
import type {
  ModelCallConfig,
  ModelProviderPort,
  TestModelResult,
} from "../ports/model-provider.port";

export const TEST_CONNECTION_TIMEOUT_MS = 10_000;

const CANONICAL_PATH: Record<ModelType, string> = {
  llm: "/chat/completions",
  embedding: "/embeddings",
  rerank: "/rerank",
};

/**
 * OpenAI 兼容适配器（M3 仅连通性测试）：按 type POST 真调用路径验"该模型可用"，
 * 一切失败（非 2xx / 形状不符 / 网络错 / 超时）都返回 {ok:false}，不抛——测试端点要友好结果。
 * 仅经 MODEL_PROVIDER_PORT token 注入消费，禁止直接 import（eslint 边界）。
 */
@Injectable()
export class OpenAiCompatAdapter implements ModelProviderPort {
  async testConnection(config: ModelCallConfig): Promise<TestModelResult> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_CONNECTION_TIMEOUT_MS);
    try {
      const resp = await fetch(buildUrl(config), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildBody(config)),
        signal: controller.signal,
      });
      const latencyMs = Date.now() - startedAt;
      const json: unknown = await resp.json().catch(() => undefined);
      if (!resp.ok) {
        return {
          ok: false,
          latencyMs,
          statusCode: resp.status,
          error: upstreamError(resp.status, json),
        };
      }
      if (!shapeOk(config.type, json)) {
        return { ok: false, latencyMs, statusCode: resp.status, error: "unexpected response shape" };
      }
      return { ok: true, latencyMs, statusCode: resp.status };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const error = controller.signal.aborted
        ? `timeout after ${TEST_CONNECTION_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err);
      return { ok: false, latencyMs, error };
    } finally {
      clearTimeout(timer);
    }
  }
}

// baseUrl 归一化：去尾斜杠；已以 canonical 路径结尾则不重复拼（原型默认 base 有全路径形态）
function buildUrl(config: ModelCallConfig): string {
  const path = CANONICAL_PATH[config.type];
  const base = config.baseUrl.replace(/\/+$/, "");
  return base.endsWith(path) ? base : `${base}${path}`;
}

function buildBody(config: ModelCallConfig): Record<string, unknown> {
  const model = config.deploymentId ?? config.name;
  if (config.type === "embedding") return { model, input: "ping" };
  if (config.type === "rerank") {
    return { model, query: "ping", documents: ["ping", "pong"], top_n: 1 };
  }
  return { model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 };
}

// 2xx 后轻量形状校验（diff D8）：防"网关 200 但模型不可用"假阳性
function shapeOk(type: ModelType, json: unknown): boolean {
  if (typeof json !== "object" || json === null) return false;
  const o = json as Record<string, unknown>;
  if (type === "llm") return Array.isArray(o.choices);
  if (type === "embedding") {
    const first = Array.isArray(o.data) ? (o.data[0] as Record<string, unknown> | undefined) : undefined;
    return Array.isArray(first?.embedding);
  }
  return Array.isArray(o.results) || Array.isArray(o.data);
}

// 脱敏：只取 status + 上游 message 截断（≤200 字符），不含 headers/apiKey/完整 body
function upstreamError(status: number, json: unknown): string {
  let message = "";
  if (typeof json === "object" && json !== null) {
    const o = json as { error?: { message?: unknown }; message?: unknown };
    const raw = o.error?.message ?? o.message;
    if (typeof raw === "string") message = raw.slice(0, 200);
  }
  return message ? `HTTP ${status}: ${message}` : `HTTP ${status}`;
}
