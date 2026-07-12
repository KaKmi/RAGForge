import { Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PromptNode } from "@codecrush/contracts";
import { withSpan } from "@codecrush/otel";
import { CODECRUSH_SPAN_KIND, GEN_AI, OTEL_OPERATIONS, RAG } from "@codecrush/otel-conventions";
import { ModelsService } from "../../models/models.service";
import type { ChatMessage, StructuredOutputSpec } from "../../models/ports/model-provider.port";
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
}

export interface StreamTextResult {
  text: string;
  fallbackUsed: boolean;
  /** M7b S0：见 ExecuteStructuredResult.traceId */
  traceId?: string;
}

export interface NodeExecuteOptions {
  /** TryRunPromptRequest.temperature / NodeSampleRequest.modelParams.temperature 透传 */
  temperature?: number;
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

    // review round 1：reservedDataSchema 此前从未校验——intent 的 extraValidate 直接
    // 索引 reserved.availableRoutes，caller 传入缺字段的 reserved（RuntimeContext 里
    // availableRoutes 是 optional）会在 extraValidate 内部抛未捕获 TypeError，而不是
    // 像 input 校验失败那样优雅降级。两个前置校验都过了才进入真正的模型调用。
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
        const structuredOutput: StructuredOutputSpec = {
          name: `${contract.key}_v${contract.version}`,
          schema: z.toJSONSchema(contract.outputSchema as z.ZodType) as Record<string, unknown>,
          strict: true,
        };
        const chatOpts = { structuredOutput, temperature: opts?.temperature };

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
          return {
            output: first.output,
            fallbackUsed: false,
            validateSteps: steps,
            traceId: span.spanContext().traceId,
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
          return {
            output: second.output,
            fallbackUsed: false,
            validateSteps: steps,
            traceId: span.spanContext().traceId,
          };
        }
        steps.push({ step: "repair", ok: false, issues: second.issues });

        steps.push({ step: "fallback", ok: true });
        span.setAttribute(RAG.FALLBACK_USED, true);
        return {
          output: contract.fallback(validInput, validReserved),
          fallbackUsed: true,
          validateSteps: steps,
          traceId: span.spanContext().traceId,
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
        try {
          const stream = await this.models.chatStream(modelId, messages, {
            temperature: opts?.temperature,
          });
          for await (const chunk of stream) {
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
