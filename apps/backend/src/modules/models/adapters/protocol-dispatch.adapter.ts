import { Injectable } from "@nestjs/common";
import type { ModelProtocol, ModelType } from "@codecrush/contracts";
import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  ChatStreamChunk,
  EmbedResult,
  ModelCallConfig,
  ModelCallOptions,
  ModelProviderPort,
  RerankResult,
  TestModelResult,
} from "../ports/model-provider.port";
import { CHAT_BUILDERS } from "./chat-builders";
import { CHAT_STREAM_BUILDERS, type ChatStreamRequestSpec } from "./chat-stream-builders";
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
import { RERANK_BUILDERS } from "./rerank-builders";

export const TEST_CONNECTION_TIMEOUT_MS = 10_000;
// embed() 批量文本量级远超探针（真实入库调用，非最小 mock 请求），10s 太紧；60s 留够真实厂商延迟余量，
// 同时仍能兜住 007 Failure modes 要求处理的「Embedding 服务超时/连接 hang」——不设超时会让 pg-boss
// 单进程 worker 永久卡死在这次 fetch 上，后续入库任务全部堆积不消费。
export const EMBED_TIMEOUT_MS = 60_000;
// rerank 在检索的同步用户路径上（008 §Requirements），不能沿用 embed() 的 60s 异步预算；
// 5s 是介于「测试连接」10s 探针与 chat 端 30s 熔断之间的工程估计，未经真实供应商实测校准
// （008 Revisit：接入真实供应商后需要重新量）。
export const RERANK_TIMEOUT_MS = 5_000;
// chat 用于试运行（012 §6 同步等待），60s 兜住真实厂商长回复；011 runtime 复用时再按需分档
export const CHAT_TIMEOUT_MS = 60_000;

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
 * F1：把外部中止信号与内部固定超时 controller 合并（Node 22 原生 `AbortSignal.any`）。
 * 外部省略时退回原 controller.signal，行为逐字节不变。
 */
function withExternalSignal(controller: AbortController, external?: AbortSignal): AbortSignal {
  return external ? AbortSignal.any([controller.signal, external]) : controller.signal;
}

/**
 * F1：中止归因——外部 signal 触发说「被中止」（不是超时），内部 controller 触发说超时文案，
 * 其余原样。区分二者让离线 run 不把硬中断误报成 provider 超时。
 */
function abortError(
  err: unknown,
  external: AbortSignal | undefined,
  controller: AbortController,
  abortedMessage: string,
  timeoutMessage: string,
): string {
  if (external?.aborted) return abortedMessage;
  if (controller.signal.aborted) return timeoutMessage;
  return err instanceof Error ? err.message : String(err);
}

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

  // M8.0：文本 chat（三层消息 + 结构化输出）。失败一律 throw（同 embed/rerank 语义），
  // 消费方（node-runtime）把 provider 错误映射为对应的降级/Fallback 行为。
  async chat(config: ModelCallConfig, messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult> {
    const builder = CHAT_BUILDERS[config.protocol];
    if (!builder) {
      // 契约层 TRY_RUN_CHAT_PROTOCOLS 已收口，调用方按矩阵返回 unavailable，此分支防御新枚举
      throw new Error(`unsupported protocol ${config.protocol} for chat`);
    }
    const req = builder(config, messages, opts ?? {});
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: withExternalSignal(controller, opts?.signal),
      });
    } catch (err) {
      const message = abortError(
        err,
        opts?.signal,
        controller,
        "chat 请求被中止",
        `chat 请求超时（>${CHAT_TIMEOUT_MS}ms）`,
      );
      throw new Error(redactSecret(message, config.apiKey));
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      const json: unknown = await resp.json().catch(() => undefined);
      throw new Error(redactSecret(upstreamError(resp.status, json), config.apiKey));
    }
    const json: unknown = await resp.json().catch(() => undefined);
    const text = req.parseText(json);
    // 200 但形状不符/空输出 → 稳定的 provider-response 错误（不静默返回空串；
    // 空串统一在此收口，builder 只负责抽取——review round 1）
    if (text === undefined || text.length === 0) {
      throw new Error("chat 响应形状不符：未找到非空文本输出");
    }
    // M8 T3：透传 token 用量（缺字段则 undefined，node-runtime 侧不 set span 属性）
    return { content: text, usage: req.parseUsage(json) };
  }

  // M8.0：流式 chat。SSE 帧解析（fetch/超时/密钥擦除同 chat()；解析残缺 JSON 时
  // parseSseFrame 内部抛出的 SyntaxError 会被下方 try/catch 捕获归一，不会未捕获
  // 逃逸——见 concerns.md Story 2 条目）。
  async *chatStream(
    config: ModelCallConfig,
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): AsyncGenerator<ChatStreamChunk> {
    const builder = CHAT_STREAM_BUILDERS[config.protocol];
    if (!builder) {
      throw new Error(`unsupported protocol ${config.protocol} for chatStream`);
    }
    const req = builder(config, messages, opts ?? {});
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: withExternalSignal(controller, opts?.signal),
      });
    } catch (err) {
      const message = abortError(
        err,
        opts?.signal,
        controller,
        "chat 流式请求被中止",
        `chat 流式请求超时（>${CHAT_TIMEOUT_MS}ms）`,
      );
      throw new Error(redactSecret(message, config.apiKey));
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok || !resp.body) {
      const json: unknown = resp.ok ? undefined : await resp.json().catch(() => undefined);
      throw new Error(redactSecret(upstreamError(resp.status, json), config.apiKey));
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE 帧以空行分隔；一次 read() 可能包含 0..N 个完整帧
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const chunk = parseSseFrame(frame, req);
          if (chunk) {
            yield chunk;
            if (chunk.done) return;
          }
        }
      }
    } catch (err) {
      throw new Error(redactSecret(err instanceof Error ? err.message : String(err), config.apiKey));
    } finally {
      // review round 1：consumer 提前 break（for-await 触发 generator.return()）时
      // finally 仍会执行——释放 reader 锁并取消底层连接，防止连接悬挂不释放。
      // cancel() 对已经自然读完（done）的流是安全 no-op，吞掉其自身可能的 reject。
      await reader.cancel().catch(() => undefined);
    }
  }

  async embed(config: ModelCallConfig, texts: string[], opts?: ModelCallOptions): Promise<EmbedResult> {
    const builder = EMBED_BUILDERS[config.protocol];
    if (!builder) {
      // 契约层已收口 embedding 合法协议组合，此分支正常不可达（防御新枚举值漏配 builder）
      throw new Error(`unsupported protocol ${config.protocol} for embedding`);
    }
    const req = builder(config, texts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: withExternalSignal(controller, opts?.signal),
      });
    } catch (err) {
      const message = abortError(
        err,
        opts?.signal,
        controller,
        "embedding 请求被中止",
        `embedding 请求超时（>${EMBED_TIMEOUT_MS}ms）`,
      );
      throw new Error(redactSecret(message, config.apiKey));
    } finally {
      clearTimeout(timer);
    }
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

  async rerank(
    config: ModelCallConfig,
    query: string,
    documents: string[],
    topN?: number,
    opts?: ModelCallOptions,
  ): Promise<RerankResult> {
    const builder = RERANK_BUILDERS[config.protocol];
    if (!builder) {
      // 契约层已收口 rerank 合法协议组合，此分支正常不可达（防御新枚举值漏配 builder）
      throw new Error(`unsupported protocol ${config.protocol} for rerank`);
    }
    const req = builder(config, query, documents, topN);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RERANK_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: withExternalSignal(controller, opts?.signal),
      });
    } catch (err) {
      const message = abortError(
        err,
        opts?.signal,
        controller,
        "rerank 请求被中止",
        `rerank 请求超时（>${RERANK_TIMEOUT_MS}ms）`,
      );
      throw new Error(redactSecret(message, config.apiKey));
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      const json: unknown = await resp.json().catch(() => undefined);
      throw new Error(redactSecret(upstreamError(resp.status, json), config.apiKey));
    }
    const json = await resp.json();
    return { results: req.parseResponse(json) };
  }
}

// SSE 帧解析：openai_compat/gemini 用 "data: <json>" 单行；anthropic 用
// "event: <type>\ndata: <json>" 两行配对——按帧内是否含 "event:" 行分流。
// JSON.parse 抛出的 SyntaxError（残缺分片）沿调用栈冒泡，由 chatStream() 的
// 外层 try/catch 统一捕获归一（不在此处吞掉——见 concerns.md Story 2 条目）。
function parseSseFrame(frame: string, req: ChatStreamRequestSpec): ChatStreamChunk | undefined {
  const lines = frame
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const eventLine = lines.find((l) => l.startsWith("event:"));
  const dataLine = lines.find((l) => l.startsWith("data:"));
  if (!dataLine) return undefined;
  const data = dataLine.slice("data:".length).trim();
  if (eventLine) {
    const event = eventLine.slice("event:".length).trim();
    return req.parseEvent(event, data);
  }
  return req.parseChunk(data);
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
