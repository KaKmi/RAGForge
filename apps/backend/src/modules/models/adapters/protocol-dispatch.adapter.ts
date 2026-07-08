import { Injectable } from "@nestjs/common";
import type { ModelProtocol, ModelType } from "@codecrush/contracts";
import type {
  EmbedResult,
  ModelCallConfig,
  ModelProviderPort,
  TestModelResult,
} from "../ports/model-provider.port";
import type { ProbeBuilder } from "./protocols/types";
import {
  openaiCompatChatProbe,
  openaiCompatEmbeddingProbe,
  openaiCompatRerankProbe,
} from "./protocols/openai-compat";
import { anthropicChatProbe } from "./protocols/anthropic";
import { geminiChatProbe, geminiEmbeddingProbe } from "./protocols/gemini";
import { cohereEmbeddingProbe, cohereRerankProbe } from "./protocols/cohere";
import { jinaEmbeddingProbe, jinaRerankProbe } from "./protocols/jina";
import { dashscopeRerankProbe } from "./protocols/dashscope";
import { selfHostedEmbeddingProbe, selfHostedRerankProbe } from "./protocols/self-hosted";
import { EMBED_BUILDERS } from "./embed-builders";

export const TEST_CONNECTION_TIMEOUT_MS = 10_000;

// (type, protocol) → 探针 builder 表：与契约 PROTOCOLS_BY_TYPE 的合法组合一一对应
// （完整性由 protocol-dispatch.adapter.spec 断言）。新增协议 = 加 builder 文件 + 表项。
export const PROBE_BUILDERS: Record<`${ModelType}:${ModelProtocol}` & string, ProbeBuilder> = {
  "llm:openai_compat": openaiCompatChatProbe,
  "llm:anthropic": anthropicChatProbe,
  "llm:gemini": geminiChatProbe,
  "embedding:self_hosted": selfHostedEmbeddingProbe,
  "embedding:openai_compat": openaiCompatEmbeddingProbe,
  "embedding:gemini": geminiEmbeddingProbe,
  "embedding:cohere": cohereEmbeddingProbe,
  "embedding:jina": jinaEmbeddingProbe,
  "rerank:self_hosted": selfHostedRerankProbe,
  "rerank:openai_compat": openaiCompatRerankProbe,
  "rerank:cohere": cohereRerankProbe,
  "rerank:jina": jinaRerankProbe,
  "rerank:dashscope": dashscopeRerankProbe,
} as Record<string, ProbeBuilder>;

/**
 * 协议分发适配器（001「协议格式为路由键」）：请求构造与响应形状校验在 protocols/* 纯函数 builder，
 * fetch / 10s 超时 / latency / 密钥擦除集中在此。一切失败（非 2xx / 形状不符 / 网络错 / 超时）
 * 都返回 {ok:false}，不抛——测试端点要友好结果。
 * 仅经 MODEL_PROVIDER_PORT token 注入消费，禁止直接 import（eslint 边界）。
 */
@Injectable()
export class ProtocolDispatchAdapter implements ModelProviderPort {
  async testConnection(config: ModelCallConfig): Promise<TestModelResult> {
    const builder = PROBE_BUILDERS[`${config.type}:${config.protocol}`];
    if (!builder) {
      // 契约层已收口合法组合，此分支正常不可达（防御新枚举值漏配 builder）
      return { ok: false, error: `unsupported protocol ${config.protocol} for ${config.type}` };
    }
    const probe = builder(config);
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_CONNECTION_TIMEOUT_MS);
    try {
      const resp = await fetch(probe.url, {
        method: "POST",
        headers: probe.headers,
        body: JSON.stringify(probe.body),
        signal: controller.signal,
      });
      const latencyMs = Date.now() - startedAt;
      const json: unknown = await resp.json().catch(() => undefined);
      if (!resp.ok) {
        return {
          ok: false,
          latencyMs,
          statusCode: resp.status,
          // 上游 message 可能回显请求里的 key（部分兼容网关如此），必须擦除
          error: redactSecret(upstreamError(resp.status, json), config.apiKey),
        };
      }
      if (!probe.shapeOk(json)) {
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
      return { ok: false, latencyMs, error: redactSecret(error, config.apiKey) };
    } finally {
      clearTimeout(timer);
    }
  }

  async embed(config: ModelCallConfig, texts: string[]): Promise<EmbedResult> {
    const builder = EMBED_BUILDERS[config.protocol];
    if (!builder) {
      // 契约层已收口 embedding 合法协议组合，此分支正常不可达（防御新枚举值漏配 builder）
      throw new Error(`unsupported protocol ${config.protocol} for embedding`);
    }
    const req = builder(config, texts);
    const resp = await fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(req.body),
    });
    if (!resp.ok) {
      const json: unknown = await resp.json().catch(() => undefined);
      throw new Error(redactSecret(upstreamError(resp.status, json), config.apiKey));
    }
    const json = await resp.json();
    const vectors = req.parseResponse(json);
    // 200 但响应形状不符时 parseResponse 返回 []/缺项——必须与输入数一致，防止静默空结果流出
    if (vectors.length !== texts.length) {
      throw new Error(
        `embedding 响应向量数与输入文本数不一致（期望 ${texts.length}，实际 ${vectors.length}）`,
      );
    }
    const malformedIdx = vectors.findIndex(
      (v) => !Array.isArray(v) || v.some((n) => typeof n !== "number"),
    );
    if (malformedIdx !== -1) {
      throw new Error(`embedding 响应形状不符：第 ${malformedIdx + 1} 个向量不是数字数组`);
    }
    const bad = vectors.find((v) => v.length !== 1024);
    if (bad) {
      throw new Error(`embedding 维度不是 1024（实际 ${bad.length}），平台统一要求 1024 维`);
    }
    return { vectors };
  }
}

// 明文 key 擦除：error message 中出现的 apiKey 一律替换（全局约束：key 不得出现在任何 error message）
function redactSecret(message: string, secret: string): string {
  return secret ? message.split(secret).join("[REDACTED]") : message;
}

// 脱敏：只取 status + 上游 message 截断（≤200 字符），不含 headers/完整 body
function upstreamError(status: number, json: unknown): string {
  let message = "";
  if (typeof json === "object" && json !== null) {
    const o = json as { error?: { message?: unknown }; message?: unknown };
    const raw = o.error?.message ?? o.message;
    if (typeof raw === "string") message = raw.slice(0, 200);
  }
  return message ? `HTTP ${status}: ${message}` : `HTTP ${status}`;
}
