import { Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PromptNode } from "@codecrush/contracts";
import { withSpan, startManualSpan, SpanStatusCode, type Context } from "@codecrush/otel";
import { CODECRUSH_SPAN_KIND, GEN_AI, OTEL_OPERATIONS, RAG } from "@codecrush/otel-conventions";
import { FIRST_TOKEN_TIMEOUT_MS } from "./stream.constants";
import { ModelsService } from "../../models/models.service";
import type {
  ChatMessage,
  ChatStreamChunk,
  StructuredOutputSpec,
} from "../../models/ports/model-provider.port";
import { NodeContractRegistry } from "../contracts/registry";
import type { NodeContract, ValidationIssue } from "../contracts/types";
import { assembleMessages } from "../compiler/assemble";
import { normalizeStructuredOutput } from "./normalize";
import type { RuntimeContext } from "../compiler/runtime-context";

export interface ValidateStep {
  step: "input" | "reserved" | "output_schema" | "extra_validate" | "repair" | "fallback";
  ok: boolean;
  issues?: string[];
}

export interface ExecuteStructuredResult<TOutput> {
  output: TOutput;
  fallbackUsed: boolean;
  validateSteps: ValidateStep[];
  /** M7b S0：模型调用路径的 span traceId（供 ReleaseCheck OPEN_PROMPT_TRY_RUN 深链）。
   *  校验失败提前返回（无 span）路径为 undefined。 */
  traceId?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface StreamTextResult {
  text: string;
  fallbackUsed: boolean;
  /** M7b S0：见 ExecuteStructuredResult.traceId */
  traceId?: string;
}

/**
 * M8 T2：streamTextChunks 的 generator 返回值（TReturn）。编排用手写 next 循环读末值，
 * 据 outcome 分支：ok/partial → 已 yield 的 token 为准；fallback → 把 text 当整段；
 * timeout → 编排 yield error 事件、不发 done。
 */
export type StreamChunksSummary =
  | {
      outcome: "ok";
      text: string;
      traceId?: string;
      usage?: { inputTokens: number; outputTokens: number };
      model?: string;
    }
  | {
      outcome: "partial";
      text: string;
      traceId?: string;
      usage?: { inputTokens: number; outputTokens: number };
      model?: string;
    }
  | {
      outcome: "fallback";
      text: string;
      traceId?: string;
      usage?: { inputTokens: number; outputTokens: number };
      model?: string;
    }
  | {
      outcome: "timeout";
      traceId?: string;
      usage?: { inputTokens: number; outputTokens: number };
      model?: string;
    };

/** 首 token 超时熔断的内部信号（仅 streamTextChunks 内部 race 用，不外泄）。 */
class FirstTokenTimeoutError extends Error {}

export interface NodeExecuteOptions {
  /** TryRunPromptRequest.temperature / NodeSampleRequest.modelParams.temperature 透传 */
  temperature?: number;
  /**
   * M9：产出就绪后基于 output 计算额外 span 属性（在 span 关闭前写入）。
   * 用于 intent 节点把「意图分类 + 路由 KB 名」落到自己的 span（数据是 output 的纯函数）。
   * 仅结构化成功/修复/兜底路径调用；抛错被吞（遥测不得中断请求）。
   */
  spanEnrich?: (output: unknown) => Record<string, string | number | boolean>;
  /**
   * 流式末值可能因消费者 abort 不可达，故把已知模型与累计 usage 同步通知根 span 所有者。
   * 回调异常必须被吞，避免指标富化进入问答关键路径。
   */
  metricsObserver?: {
    onModel?: (model: string) => void;
    onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  };
}

export interface NodeSampleRequest {
  node: PromptNode;
  contractVersion: number;
  promptVersionId: string;
  promptBody: string;
  modelId: string;
  // topP 当前无协议层落点（011/009 均未定义注入方式），接收但不使用——
  // 见 spec.md Risks #8，不在本任务内擅自发明映射规则。
  modelParams: { temperature: number; topP: number };
  samples: Array<{ input: unknown; runtimeContext: RuntimeContext }>;
}

export interface NodeSampleResult {
  ok: boolean;
  results: Array<{
    sampleIndex: number;
    ok: boolean;
    fallbackUsed: boolean;
    issues: ValidationIssue[];
    traceId?: string;
  }>;
}

// 011 Design §2 协议适配矩阵：本任务只支持三个 llm 协议的首选机制，不做能力探测/降级
export const SUPPORTED_CHAT_PROTOCOLS = ["openai_compat", "anthropic", "gemini"] as const;

/** 协议不在 SUPPORTED_CHAT_PROTOCOLS 内——prompts.service 捕获后转 unavailable/unsupported_protocol */
export class UnsupportedChatProtocolError extends Error {}

/**
 * M8 T3：把累计 token 用量写为 gen_ai.usage.* span 属性（>0 才写，避免 0 噪声与"未取到数"混淆）。
 * 结构化入参而非 @opentelemetry/api 的 Span 类型：node-runtime 不直接依赖 @opentelemetry/api（边界）。
 */
function setUsageAttrs(
  span: { setAttribute(key: string, value: number): void },
  inputTokens: number,
  outputTokens: number,
): void {
  if (inputTokens > 0) span.setAttribute(GEN_AI.USAGE_INPUT_TOKENS, inputTokens);
  if (outputTokens > 0) span.setAttribute(GEN_AI.USAGE_OUTPUT_TOKENS, outputTokens);
}

/** M8 T3：流式 chunk 的 usage 逐字段合并（openai/gemini 末帧同时给两值、anthropic 分帧到达）。 */
function mergeStreamUsage(
  acc: { inputTokens: number; outputTokens: number },
  usage: { inputTokens: number; outputTokens: number },
): void {
  if (usage.inputTokens) acc.inputTokens = usage.inputTokens;
  if (usage.outputTokens) acc.outputTokens = usage.outputTokens;
}

@Injectable()
export class NodeRuntimeService {
  constructor(private readonly models: ModelsService) {}

  /** 查模型行 + 协议合法性检查（两处调用方共用，一次查询同时服务两个目的：拒绝非法协议 + 拿 GEN_AI span 属性） */
  private async resolveModel(modelId: string) {
    const model = await this.models.get(modelId);
    if (!(SUPPORTED_CHAT_PROTOCOLS as readonly string[]).includes(model.protocol)) {
      throw new UnsupportedChatProtocolError(
        `protocol ${model.protocol} 不支持 NodeRuntime 结构化/流式调用`,
      );
    }
    return model;
  }

  async executeStructured<TInput extends Record<string, unknown>, TOutput, TReserved>(
    node: PromptNode,
    contractVersion: number,
    promptBody: string,
    modelId: string,
    input: TInput,
    reserved: TReserved,
    opts?: NodeExecuteOptions,
  ): Promise<ExecuteStructuredResult<TOutput>> {
    const contract = NodeContractRegistry.resolve(node, contractVersion) as unknown as NodeContract<
      TInput,
      TOutput,
      TReserved
    >;
    const steps: ValidateStep[] = [];

    // review round 1：input/reserved 两步前置校验——校验失败即优雅降级为 fallback，
    // 不把缺字段的 reserved 带进下游（否则消费 reserved 的逻辑会抛未捕获 TypeError，
    // 而非像 input 校验失败那样降级）。两个前置校验都过了才进入真正的模型调用。
    const inputCheck = contract.inputSchema.safeParse(input);
    steps.push({
      step: "input",
      ok: inputCheck.success,
      issues: inputCheck.success ? undefined : inputCheck.error.issues.map((i) => i.message),
    });
    if (!inputCheck.success) {
      return {
        output: contract.fallback(input, reserved),
        fallbackUsed: true,
        validateSteps: [...steps, { step: "fallback", ok: true }],
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }

    const reservedCheck = contract.reservedDataSchema.safeParse(reserved);
    steps.push({
      step: "reserved",
      ok: reservedCheck.success,
      issues: reservedCheck.success ? undefined : reservedCheck.error.issues.map((i) => i.message),
    });
    if (!reservedCheck.success) {
      return {
        output: contract.fallback(input, reserved),
        fallbackUsed: true,
        validateSteps: [...steps, { step: "fallback", ok: true }],
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }
    // 后续统一用校验/归一后的值（含 Zod default，如 REPLY_CONTRACT.citations 缺省 []），
    // 不再用调用方传入的原始 input/reserved——两者在校验通过后语义等价，但已归一化的值更可信。
    const validInput = inputCheck.data;
    const validReserved = reservedCheck.data;

    const model = await this.resolveModel(modelId);

    return withSpan(
      "node_runtime.execute_structured",
      {
        attributes: {
          [RAG.NODE_NAME]: node,
          [RAG.PROMPT_CONTRACT_VERSION]: contractVersion,
          [GEN_AI.OPERATION_NAME]: OTEL_OPERATIONS.CHAT,
          [GEN_AI.SYSTEM]: model.protocol,
          [GEN_AI.REQUEST_MODEL]: model.deploymentId ?? model.name,
          [RAG.STRUCTURED_OUTPUT_MODE]: "json_schema",
          "codecrush.span.kind": CODECRUSH_SPAN_KIND.LLM,
        },
      },
      async (span) => {
        // M9：把 output 派生的属性（如 intent 路由）写到本 span；遥测异常不得冒泡中断请求。
        const applyEnrich = (output: TOutput): void => {
          if (!opts?.spanEnrich) return;
          try {
            for (const [k, v] of Object.entries(opts.spanEnrich(output))) span.setAttribute(k, v);
          } catch {
            /* 遥测富化失败静默：不影响回答产出 */
          }
        };
        const structuredOutput: StructuredOutputSpec = {
          name: `${contract.key}_v${contract.version}`,
          schema: z.toJSONSchema(contract.outputSchema as z.ZodType) as Record<string, unknown>,
          strict: true,
        };
        const chatOpts = { structuredOutput, temperature: opts?.temperature };
        // M8 T3：两次尝试（首次 + 修复）是两次独立 completion，token 用量求和
        let uin = 0;
        let uout = 0;

        // review round 1：区分"输出不是合法结构"(output_schema) 与"结构合法但触发
        // 动态值域校验"(extra_validate) 两类失败原因，validateSteps 才能真正驱动
        // 前端按阶段渲染的"校验步骤图标"，而不是把两种性质不同的失败都糊成一个标签。
        const attempt = async (
          messages: ChatMessage[],
        ): Promise<
          | { ok: true; output: TOutput }
          | { ok: false; step: "output_schema" | "extra_validate"; issues: string[] }
        > => {
          const res = await this.models.chat(modelId, messages, chatOpts);
          if (res.usage) {
            uin += res.usage.inputTokens;
            uout += res.usage.outputTokens;
          }
          const normalized = normalizeStructuredOutput(res.content);
          let parsed: unknown;
          try {
            parsed = JSON.parse(normalized);
          } catch {
            return { ok: false, step: "output_schema", issues: ["模型输出不是合法 JSON"] };
          }
          const outCheck = contract.outputSchema.safeParse(parsed);
          if (!outCheck.success) {
            return {
              ok: false,
              step: "output_schema",
              issues: outCheck.error.issues.map((i) => i.message),
            };
          }
          const extra = contract.extraValidate?.(outCheck.data, validReserved) ?? [];
          if (extra.length > 0) {
            return { ok: false, step: "extra_validate", issues: extra.map((i) => i.message) };
          }
          return { ok: true, output: outCheck.data };
        };

        const messages = assembleMessages({
          contract,
          promptBody,
          input: validInput,
          reserved: validReserved,
        });
        const first = await attempt(messages);
        if (first.ok) {
          steps.push({ step: "output_schema", ok: true });
          span.setAttribute(RAG.FALLBACK_USED, false);
          span.setAttribute(RAG.REPAIR_RETRY_COUNT, 0);
          setUsageAttrs(span, uin, uout);
          applyEnrich(first.output);
          return {
            output: first.output,
            fallbackUsed: false,
            validateSteps: steps,
            traceId: span.spanContext().traceId,
            usage: { inputTokens: uin, outputTokens: uout },
          };
        }
        steps.push({ step: first.step, ok: false, issues: first.issues });
        span.setAttribute(RAG.VALIDATION_ERROR_CODE, first.issues[0] ?? "unknown");

        const repairMessages: ChatMessage[] = [
          ...messages,
          {
            role: "user",
            content: `上一次输出未通过校验：${first.issues.join("; ")}。请重新输出，严格符合 JSON Schema，不要输出除 JSON 以外的任何内容。`,
          },
        ];
        const second = await attempt(repairMessages);
        span.setAttribute(RAG.REPAIR_RETRY_COUNT, 1);
        if (second.ok) {
          steps.push({ step: "repair", ok: true });
          span.setAttribute(RAG.FALLBACK_USED, false);
          setUsageAttrs(span, uin, uout);
          applyEnrich(second.output);
          return {
            output: second.output,
            fallbackUsed: false,
            validateSteps: steps,
            traceId: span.spanContext().traceId,
            usage: { inputTokens: uin, outputTokens: uout },
          };
        }
        steps.push({ step: "repair", ok: false, issues: second.issues });

        steps.push({ step: "fallback", ok: true });
        span.setAttribute(RAG.FALLBACK_USED, true);
        setUsageAttrs(span, uin, uout);
        const fbOutput = contract.fallback(validInput, validReserved);
        applyEnrich(fbOutput);
        return {
          output: fbOutput,
          fallbackUsed: true,
          validateSteps: steps,
          traceId: span.spanContext().traceId,
          usage: { inputTokens: uin, outputTokens: uout },
        };
      },
    );
  }

  async streamText<
    TInput extends Record<string, unknown>,
    TOutput extends { text: string },
    TReserved,
  >(
    node: PromptNode,
    contractVersion: number,
    promptBody: string,
    modelId: string,
    input: TInput,
    reserved: TReserved,
    opts?: NodeExecuteOptions,
  ): Promise<StreamTextResult> {
    const contract = NodeContractRegistry.resolve(node, contractVersion) as unknown as NodeContract<
      TInput,
      TOutput,
      TReserved
    >;
    // fallback 是版本化纯文本：Prompt 正文就是最终回复，永不调用模型、不渲染字段。
    // 空正文仅用于兼容存量/异常数据，降级到平台固定文案并标记 fallbackUsed，供门禁阻断。
    if (contract.node === "fallback") {
      const text = promptBody.trim();
      return text.length > 0
        ? { text, fallbackUsed: false }
        : { text: contract.fallback(input, reserved).text, fallbackUsed: true };
    }

    // review P2：streamText 此前对 input/reserved 零校验，直接把调用方的原始值传进
    // assembleMessages()（Object.entries(input) 遇 null/undefined 抛未捕获 TypeError）。
    // 与 executeStructured 对齐，同样两步校验失败即优雅降级为 fallback，不调用模型。
    const inputCheck = contract.inputSchema.safeParse(input);
    const reservedCheck = contract.reservedDataSchema.safeParse(reserved);
    if (!inputCheck.success || !reservedCheck.success) {
      return { text: contract.fallback(input, reserved).text, fallbackUsed: true };
    }
    const validInput = inputCheck.data;
    const validReserved = reservedCheck.data;

    const model = await this.resolveModel(modelId);

    return withSpan(
      "node_runtime.stream_text",
      {
        attributes: {
          [RAG.NODE_NAME]: node,
          [RAG.PROMPT_CONTRACT_VERSION]: contractVersion,
          [GEN_AI.OPERATION_NAME]: OTEL_OPERATIONS.CHAT,
          [GEN_AI.SYSTEM]: model.protocol,
          [GEN_AI.REQUEST_MODEL]: model.deploymentId ?? model.name,
          "codecrush.span.kind": CODECRUSH_SPAN_KIND.LLM,
        },
      },
      async (span) => {
        const messages = assembleMessages({
          contract,
          promptBody,
          input: validInput,
          reserved: validReserved,
        });
        let text = "";
        const usageAcc = { inputTokens: 0, outputTokens: 0 };
        try {
          const stream = await this.models.chatStream(modelId, messages, {
            temperature: opts?.temperature,
          });
          for await (const chunk of stream) {
            if (chunk.usage) mergeStreamUsage(usageAcc, chunk.usage);
            if (chunk.error) {
              // review round 1：报错时不再无条件清空 text——011 Design 明确区分"首 token
              // 前报错/空响应"(无痕切 fallback) 和"已发送 token 后断流"(不可撤回已产出内容)。
              // 是否触发 fallback 完全由下面 text.length===0 判断，不在这里预先决定。
              break;
            }
            if (chunk.delta) text += chunk.delta;
            if (chunk.done) break;
          }
        } catch {
          // 网络层异常同样只看已产出内容：text 非空则保留，不清空。
        }
        setUsageAttrs(span, usageAcc.inputTokens, usageAcc.outputTokens);
        if (text.length === 0) {
          span.setAttribute(RAG.FALLBACK_USED, true);
          return {
            text: contract.fallback(validInput, validReserved).text,
            fallbackUsed: true,
            traceId: span.spanContext().traceId,
          };
        }
        span.setAttribute(RAG.FALLBACK_USED, false);
        return { text, fallbackUsed: false, traceId: span.spanContext().traceId };
      },
    );
  }

  /**
   * M8 T2：reply 节点真流式——逐 delta yield（对照 streamText 整段返回）。
   * 内部持手动 LLM span（跨 yield 存活，显式挂父到 parentCtx，不靠活动上下文）+ 首 token 超时熔断。
   * fallback 节点/校验失败仍走整段 fallback（不进真流），summary 回传 outcome 供编排分支。
   */
  async *streamTextChunks<
    TInput extends Record<string, unknown>,
    TOutput extends { text: string },
    TReserved,
  >(
    node: PromptNode,
    contractVersion: number,
    promptBody: string,
    modelId: string,
    input: TInput,
    reserved: TReserved,
    opts?: NodeExecuteOptions,
    parentCtx?: Context,
  ): AsyncGenerator<{ delta: string }, StreamChunksSummary> {
    const contract = NodeContractRegistry.resolve(node, contractVersion) as unknown as NodeContract<
      TInput,
      TOutput,
      TReserved
    >;
    // fallback 节点不进真流（版本化纯文本，无 delta）；误调时防御性整段返回
    if (contract.node === "fallback") {
      const t = promptBody.trim();
      return { outcome: "fallback", text: t.length > 0 ? t : contract.fallback(input, reserved).text };
    }
    // 与 streamText 一致的两步前置校验：失败即 fallback，不调模型
    const inputCheck = contract.inputSchema.safeParse(input);
    const reservedCheck = contract.reservedDataSchema.safeParse(reserved);
    if (!inputCheck.success || !reservedCheck.success) {
      return { outcome: "fallback", text: contract.fallback(input, reserved).text };
    }
    const validInput = inputCheck.data;
    const validReserved = reservedCheck.data;
    const model = await this.resolveModel(modelId);
    const modelLabel = model.deploymentId ?? model.name;
    try {
      opts?.metricsObserver?.onModel?.(modelLabel);
    } catch {
      /* 指标富化失败静默：不影响回答产出 */
    }

    const { span } = startManualSpan(
      "node_runtime.stream_text",
      {
        attributes: {
          [RAG.NODE_NAME]: node,
          [RAG.PROMPT_CONTRACT_VERSION]: contractVersion,
          [GEN_AI.OPERATION_NAME]: OTEL_OPERATIONS.CHAT,
          [GEN_AI.SYSTEM]: model.protocol,
          [GEN_AI.REQUEST_MODEL]: modelLabel,
          "codecrush.span.kind": CODECRUSH_SPAN_KIND.LLM,
        },
      },
      parentCtx,
    );
    const traceId = span.spanContext().traceId;
    let text = "";
    const usageAcc = { inputTokens: 0, outputTokens: 0 }; // M8 T3：跨帧累计 usage，finally 统一落 span
    let interrupted = false; // 已发 token 后 error/异常中断 → partial（区别于正常读完的 ok）
    let timer: ReturnType<typeof setTimeout> | undefined; // 单一首 token 计时器，外层 finally 统一清
    let it: AsyncIterator<ChatStreamChunk> | undefined; // 方法作用域：finally 显式 return() 级联取消上游
    try {
      const messages = assembleMessages({
        contract,
        promptBody,
        input: validInput,
        reserved: validReserved,
      });
      const stream = await this.models.chatStream(modelId, messages, {
        temperature: opts?.temperature,
      });
      it = stream[Symbol.asyncIterator]();

      // —— 首 token 超时：单一计时器覆盖"从流开始到第一个非空 delta 到达"的累计窗口 ——
      // review 修复：先前每次 it.next() 新建 timer 会（a）泄漏旧 timer（b）每来一个前置空/keepalive
      // 帧就重置窗口，使 breaker 形同虚设（anthropic message_start/ping、openai role 首帧都映射为空 delta）。
      // 单一 deadline 只在首个非空 delta 到达时 clear，故窗口累计、且只有一个计时器。
      let sawDelta = false;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new FirstTokenTimeoutError()), FIRST_TOKEN_TIMEOUT_MS);
      });
      const firstTokenGate = <T>(p: Promise<T>): Promise<T> =>
        sawDelta ? p : Promise.race([p, deadline]);

      try {
        let res = await firstTokenGate(it.next());
        while (!res.done) {
          const chunk = res.value;
          if (chunk.usage) {
            mergeStreamUsage(usageAcc, chunk.usage); // usage 帧无 delta，仅记账
            try {
              opts?.metricsObserver?.onUsage?.({ ...usageAcc });
            } catch {
              /* 指标富化失败静默：不影响回答产出 */
            }
          }
          if (chunk.error) {
            interrupted = true; // 首 token 前：text 仍空 → 下方转 fallback；已发 token：保留为 partial
            break;
          }
          if (chunk.delta) {
            if (!sawDelta) {
              sawDelta = true;
              if (timer) clearTimeout(timer); // 首 delta 到达，撤计时器，后续不再熔断/不再 race deadline
            }
            text += chunk.delta;
            yield { delta: chunk.delta };
          }
          if (chunk.done) break;
          res = await firstTokenGate(it.next());
        }
      } catch (err) {
        if (err instanceof FirstTokenTimeoutError) {
          // it.return() 由 finally 统一级联；此处只定状态并返回 outcome
          span.setStatus({ code: SpanStatusCode.ERROR, message: "first token timeout" });
          span.setAttribute(RAG.FALLBACK_USED, false);
          return {
            outcome: "timeout",
            traceId,
            usage: { ...usageAcc },
            model: modelLabel,
          };
        }
        interrupted = true; // 网络层异常：只看已产出（text 非空保留为 partial，空则下方 fallback）
      }

      if (text.length === 0) {
        span.setAttribute(RAG.FALLBACK_USED, true);
        return {
          outcome: "fallback",
          text: contract.fallback(validInput, validReserved).text,
          traceId,
          usage: { ...usageAcc },
          model: modelLabel,
        };
      }
      span.setStatus({ code: SpanStatusCode.OK });
      span.setAttribute(RAG.FALLBACK_USED, false);
      return {
        outcome: interrupted ? "partial" : "ok",
        text,
        traceId,
        usage: { ...usageAcc },
        model: modelLabel,
      };
    } finally {
      if (timer) clearTimeout(timer);
      // M8 T3：所有结束路径（ok/partial/fallback/timeout/abort）统一落 usage span 属性
      setUsageAttrs(span, usageAcc.inputTokens, usageAcc.outputTokens);
      // 级联取消上游：消费者提前 return()（abort）/ 超时 / error 后，显式 return 底层 chatStream 迭代器，
      // 触发其 finally 的 reader.cancel()，避免上游 fetch 悬挂到 CHAT_TIMEOUT_MS（review 发现，AC6）。
      // return() 对已读完/已 return 的迭代器是安全 no-op。
      if (it) await it.return?.(undefined);
      span.end(); // 手动生命周期：所有路径必 end（含 return / 异常 / 消费者 abort）
    }
  }

  async compileAndSample(request: NodeSampleRequest): Promise<NodeSampleResult> {
    const opts: NodeExecuteOptions = { temperature: request.modelParams.temperature };
    const results: NodeSampleResult["results"] = [];
    for (let i = 0; i < request.samples.length; i++) {
      const sample = request.samples[i];
      try {
        if (request.node === "reply" || request.node === "fallback") {
          const r = await this.streamText(
            request.node,
            request.contractVersion,
            request.promptBody,
            request.modelId,
            sample.input as Record<string, unknown>,
            sample.runtimeContext,
            opts,
          );
          results.push({
            sampleIndex: i,
            ok: !r.fallbackUsed,
            fallbackUsed: r.fallbackUsed,
            issues: [],
            traceId: r.traceId,
          });
        } else {
          const r = await this.executeStructured(
            request.node,
            request.contractVersion,
            request.promptBody,
            request.modelId,
            sample.input as Record<string, unknown>,
            sample.runtimeContext,
            opts,
          );
          const issues = r.validateSteps.flatMap((s) =>
            (s.issues ?? []).map((message) => ({ code: s.step.toUpperCase(), message })),
          );
          results.push({
            sampleIndex: i,
            ok: !r.fallbackUsed,
            fallbackUsed: r.fallbackUsed,
            issues,
            traceId: r.traceId,
          });
        }
      } catch (err) {
        // review P2：单样例的基础设施失败（模型不存在/网络异常等，非业务校验失败）此前
        // 未被捕获，会直接抛出中断整个批次，丢弃已聚合的其他样例结果。NodeSampleResult
        // 的设计契约是"每个样例独立"，此处补齐隔离，让调用方拿到"21/22 通过，1 个失败：
        // <原因>"而不是整批 unhandled rejection。
        results.push({
          sampleIndex: i,
          ok: false,
          fallbackUsed: false,
          issues: [
            { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : String(err) },
          ],
        });
      }
    }
    return { ok: results.every((r) => r.ok), results };
  }
}
