import { Injectable, Logger } from "@nestjs/common";
import {
  CHAT_INTENT_KEY,
  INTENT_TABLE,
  type ChatCitation,
  type ChatStreamEvent,
  type FallbackInfo,
  type FallbackReason,
  type ResolvedNodeConfig,
} from "@codecrush/contracts";
import { startManualSpan, runInContext, SpanStatusCode } from "@codecrush/otel";
import {
  CODECRUSH_IO,
  CODECRUSH_SPAN_KIND,
  ENDUSER_ID,
  GEN_AI,
  RAG,
  SESSION_ID,
} from "@codecrush/otel-conventions";
import { ApplicationsService } from "../applications/applications.service";
import { NodeRuntimeService } from "../node-runtime/executor/node-runtime.service";
import { RetrievalService } from "../retrieval/retrieval.service";
import { KnowledgeBasesService } from "../knowledge-bases/knowledge-bases.service";
import { ConversationsService } from "../conversations/conversations.service";
import { buildRetrievalRequests, mergeHits, type TaggedHit } from "./retrieval-mapping";
import {
  decideFallback,
  deriveConfidence,
  deriveCoverage,
  deriveQualitySignals,
  resolveRetrievalKbIds,
} from "./derived-metrics";
import { FALLBACK_THRESHOLD } from "./orchestration.constants";
import type { OrchestrationResult } from "./orchestration.types";

const TITLE_MAX = 30;
const HISTORY_MAX_MESSAGES = 6;

/** 预备阶段（rewrite→intent→路由→检索→判定）的产物，供流式阶段消费。全在首个 yield 前算完。 */
interface PrepResult {
  branch: "reply" | "fallback";
  citations: ChatCitation[];
  retrievalContext: string;
  history?: string;
  validConvId?: string;
  isFallback: boolean;
  reasons: FallbackReason[];
  fallbackInfo: FallbackInfo;
}

/**
 * M8 RAG 编排内核（013 §编排 + 014 意图路由）：
 * resolvePublic → rewrite → intent → 路由映射 → 逐 KB 检索合并 → 生成/兜底 → 派生指标 → 落库。
 * chain 根 span 用 startManualSpan 手动生命周期（跨 yield 存活），子 span 经 runInContext 显式挂父。
 * T2 逐 token 真流式：run() 返回 AsyncGenerator<ChatStreamEvent>，reply 走 streamTextChunks 逐 token yield。
 */
@Injectable()
export class OrchestrationService {
  private readonly logger = new Logger(OrchestrationService.name);

  constructor(
    private readonly applications: ApplicationsService,
    private readonly nodeRuntime: NodeRuntimeService,
    private readonly retrieval: RetrievalService,
    private readonly kbs: KnowledgeBasesService,
    private readonly conversations: ConversationsService,
  ) {}

  async *run(
    agentId: string,
    query: string,
    convId?: string,
    userId?: string,
  ): AsyncGenerator<ChatStreamEvent> {
    // resolvePublic 在 chain span 之外：未上线/停用异常直接冒泡给 controller 翻 404/403（写头之前）。
    const cfg = await this.applications.resolvePublic(agentId);

    // chain 根 span 用手动生命周期：跨 yield 存活，finally 手动 end（withSpan 撑不住流式）。
    const { span: chain, ctx: chainCtx } = startManualSpan("rag.pipeline", {
      attributes: {
        "codecrush.span.kind": CODECRUSH_SPAN_KIND.CHAIN,
        [RAG.PROMPT_VERSION_ID]: cfg.configVersionId,
        [RAG.PREVIEW]: cfg.preview,
      },
    });
    const traceId = chain.spanContext().traceId;
    // M8 T3：输入即得，起始即记（通用 IO 属性；导出前经 RedactingSpanExporter 脱敏）
    chain.setAttribute(CODECRUSH_IO.INPUT, query);
    // M9 W1：身份富化——agentId/userId 入口即得，cfg.name 已解析；session.id 须待 persist 出真 convId（见 finally）。
    chain.setAttribute(GEN_AI.AGENT_ID, agentId);
    chain.setAttribute(GEN_AI.AGENT_NAME, cfg.name);
    if (userId) chain.setAttribute(ENDUSER_ID, userId);
    // 首轮新会话的真实 convId 在 persist() 内 createConversation 才产生 → 捕获返回、finally end 前写 session.id。
    let sessionId = "";
    let replyText = "";
    let completed = false;
    let prep: PrepResult | undefined;
    let persistCtx: { agentId: string; query: string; convId?: string; userId?: string } | undefined;
    // reply 迭代器提到外层：手动 next() 循环不像 for-await 那样自动传播 return()，故 finally
    // 显式 return() 级联取消上游（streamTextChunks → chatStream → reader.cancel）+ 结束 reply span。
    let replyIt: AsyncGenerator<{ delta: string }, unknown> | undefined;
    // M8 T3：所有结束路径统一写 output + 四质量布尔（每路径恰一次；prep 未就绪的 infra 早失败不写）。
    let signalsWritten = false;
    // reply 分支模型输出未过契约校验 → streamTextChunks 返回 outcome=fallback（把兜底话术当整段）；
    // 这也是「生成拒答」，但不在 prep.isFallback（那是检索层兜底判定）里——单独记，供 refusal 信号。
    let replyDegraded = false;
    const finalizeChainSignals = (timedOut: boolean): void => {
      if (signalsWritten || !prep) return;
      signalsWritten = true;
      chain.setAttribute(CODECRUSH_IO.OUTPUT, replyText);
      const sig = deriveQualitySignals({
        // refusal = 检索层兜底 或 reply 节点契约降级（两类"生成拒答"都算，对齐 docstring）
        isFallback: prep.isFallback || replyDegraded,
        reasons: prep.reasons,
        citationCount: prep.citations.length,
        timedOut,
      });
      chain.setAttribute(RAG.QUALITY_LOW_RECALL, sig.lowRecall);
      chain.setAttribute(RAG.QUALITY_NO_CITATIONS, sig.noCitations);
      chain.setAttribute(RAG.QUALITY_REFUSAL, sig.refusal);
      chain.setAttribute(RAG.QUALITY_TIMEOUT, sig.timeout);
      // M9 W1：兜底状态判据——检索层未命中走兜底话术（区别于 refusal=isFallback||replyDegraded，PDF「兜底=知识未命中」）
      chain.setAttribute(RAG.FALLBACK_USED, prep.isFallback);
    };

    try {
      // —— 预备阶段：整段在 chainCtx 内（内部无 yield），子 span（rewrite/intent/检索）自动挂 chain ——
      prep = await runInContext(chainCtx, () => this.prepare(agentId, query, convId, cfg));
      persistCtx = { agentId, query, convId: prep.validConvId, userId };

      // —— 流式阶段 ——
      for (const c of prep.citations) yield { type: "citation", citation: c };

      if (prep.branch === "fallback") {
        // 兜底/CHAT：整段（streamText，无 delta 可吐），单 token yield
        const text = await runInContext(chainCtx, () => this.streamNode(cfg.nodes.fallback, "fallback"));
        replyText = text;
        if (text) yield { type: "token", delta: text };
      } else {
        // 正常 reply：逐 token 真流式（streamTextChunks），reply LLM span 显式挂父到 chainCtx。
        const it = this.nodeRuntime.streamTextChunks(
          "reply",
          cfg.nodes.reply.contractVersion,
          cfg.nodes.reply.promptBody,
          cfg.nodes.reply.modelId,
          { query, history: prep.history, retrievalContext: prep.retrievalContext },
          { citations: prep.citations },
          { temperature: cfg.nodes.reply.temperature },
          chainCtx,
        );
        replyIt = it; // 供 finally 级联 return()（abort 时取消上游 + 结束 reply span，AC6）
        try {
          let res = await it.next();
          while (!res.done) {
            replyText += res.value.delta;
            yield { type: "token", delta: res.value.delta };
            res = await it.next();
          }
          const summary = res.value;
          if (summary.outcome === "timeout") {
            // 降级路径也要在后端日志留痕（不只 span），否则无 ClickHouse 时排查无迹（QA 观察 2）。
            this.logger.warn(`reply 首 token 超时熔断（agentId=${agentId}, traceId=${traceId}）`);
            chain.setStatus({ code: SpanStatusCode.ERROR, message: "first token timeout" });
            finalizeChainSignals(true); // 唯一 timedOut=true 路径（其余路径由 finally 写 false）
            yield { type: "error", message: "生成超时，请稍后重试" };
            sessionId = (await this.persist(this.buildResult(traceId, "", prep), persistCtx)) ?? persistCtx?.convId ?? sessionId;
            completed = true;
            return; // 熔断：不发 done
          }
          if (summary.outcome === "fallback") {
            // reply 节点降级：把 reply 契约 fallback 文本当整段（同 T1 streamNode 语义），branch 仍算 reply
            replyDegraded = true; // 记为「生成拒答」→ refusal 质量信号（review Finding 1）
            replyText = summary.text;
            if (summary.text) yield { type: "token", delta: summary.text };
          }
          // ok / partial：replyText 已逐 token 累加
        } catch (err) {
          // reply 节点 infra 失败（模型被删/协议不支持 → resolveModel 抛；或提示词非法字段 →
          // assembleMessages 抛）发生在首帧后，HTTP 头已发，不能截断流 → 优雅降级为 error 事件收尾
          // （对齐 timeout；不冒泡截断，review Finding 2）。
          // 除记 span 外必须写后端日志：该路径不 rethrow，Nest 异常过滤器看不到它，无 ClickHouse
          // 时将完全无迹可查（QA 观察 2——真实环境靠此定位过提示词非法字段 {context}）。
          this.logger.error(
            `reply 生成失败降级（agentId=${agentId}, traceId=${traceId}）：${(err as Error).message}`,
          );
          chain.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
          chain.recordException(err as Error);
          yield { type: "error", message: "生成失败，请稍后重试" };
          sessionId = (await this.persist(this.buildResult(traceId, replyText, prep), persistCtx)) ?? persistCtx?.convId ?? sessionId;
          completed = true;
          return;
        }
      }

      // —— 派生指标 + 落库 + done（先 persist+completed，再 yield，杜绝 yield 处 abort 致重复落库）——
      const result = this.buildResult(traceId, replyText, prep);
      const persistedConvId = await this.persist(result, persistCtx);
      sessionId = persistedConvId ?? persistCtx?.convId ?? sessionId; // M9 W1：首轮取 persist 生成的真 convId
      const doneConvId = persistedConvId ?? prep.validConvId; // 可能 undefined（落库彻底失败）
      completed = true;
      chain.setStatus({ code: SpanStatusCode.OK });
      yield {
        type: "done",
        traceId,
        // M8 T4：契约 convId 可选——有值才带（新会话回填/续聊定位），落库失败时省略不发空串
        ...(doneConvId ? { convId: doneConvId } : {}),
        confidence: result.confidence,
        coverage: result.coverage,
        isFallback: result.isFallback,
        fallbackReasons: result.fallbackReasons,
      };
    } catch (err) {
      // 预备阶段异常（infra 级）在首个 yield 前发生 → 记 span 并冒泡给 controller（写头前 → 500）。
      chain.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      chain.recordException(err as Error);
      throw err;
    } finally {
      if (!completed && persistCtx && prep) {
        // 客户端 abort（gen.return()）：落已产出部分 assistant 内容（复用现有字段，无 aborted 列）。
        try {
          sessionId = (await this.persist(this.buildResult(traceId, replyText, prep), persistCtx)) ?? persistCtx?.convId ?? sessionId;
        } catch (e) {
          this.logger.error(`abort 落部分失败（边界7 兜住）：${(e as Error).message}`);
        }
      }
      // 手动 next() 循环不自动传播 return()：显式级联 return reply 迭代器，触发 streamTextChunks
      // 的 finally（reader.cancel + reply span.end），避免 abort 时上游 fetch 悬挂/span 泄漏（Finding 1）。
      // 对已读完/已抛错/已 return 的迭代器是安全 no-op。try 包裹保证 return 万一 reject 也不跳过 chain.end。
      try {
        if (replyIt) await replyIt.return?.(undefined);
      } catch (e) {
        this.logger.warn(`reply 迭代器 return 级联异常（忽略）：${(e as Error).message}`);
      }
      // M8 T3：非 timeout 路径（正常/reply-fail/abort）在此统一写 output + 四质量布尔 timedOut=false；
      // timeout 路径已在熔断处 finalize(true)，signalsWritten 去重保证不被覆盖。prep 未就绪的 infra
      // 早失败（prepare 抛）prep=undefined，finalize guard 跳过（早失败无质量信号可言）。
      finalizeChainSignals(false);
      // M9 W1：session.id 待此写——首轮新会话的真 convId 已由各 persist 路径捕获进 sessionId。
      if (sessionId) chain.setAttribute(SESSION_ID, sessionId);
      chain.end(); // 手动生命周期：所有路径必 end
    }
  }

  /** 预备阶段：rewrite→intent→路由→检索→兜底判定，产出 PrepResult。无 yield，供 runInContext 包裹挂父。 */
  private async prepare(
    agentId: string,
    query: string,
    convId: string | undefined,
    cfg: Awaited<ReturnType<ApplicationsService["resolvePublic"]>>,
  ): Promise<PrepResult> {
    const kbRows = await this.kbs.findByIds(cfg.kbIds);
    const kbNameById = new Map(kbRows.map((k) => [k.id, k.name]));
    // review P2：convId 归属校验——客户端自报的 convId 若属于别的 agentId，不得读其历史
    // 或写入其消息（跨应用会话串号）；不属于/不存在均按未传 convId 处理，降级新建会话。
    const validConvId = await this.resolveConvId(agentId, convId);
    const history = await this.loadHistory(validConvId);

    // 1) rewrite：降级时契约 fallback 已回填原 query
    const rewrite = await this.executeNode<{ rewrittenQuery: string }>(
      cfg.nodes.rewrite,
      "rewrite",
      { query, history },
      {},
    );
    const rewrittenQuery = rewrite.rewrittenQuery;

    // 2) intent：候选恒注入静态全表（014 D3）
    const intentOut = await this.executeNode<{ intent: string }>(
      cfg.nodes.intent,
      "intent",
      { query, history },
      { availableIntents: INTENT_TABLE },
    );
    const intent = intentOut.intent;

    // 3) CHAT 短路：不检索，直走兜底（014 D4）
    if (intent === CHAT_INTENT_KEY) {
      const reasons: FallbackReason[] = ["chitchat", "handled_by_fallback"];
      return {
        branch: "fallback",
        citations: [],
        retrievalContext: "",
        history,
        validConvId,
        isFallback: true,
        reasons,
        fallbackInfo: { reasons, scopeKbNames: [] },
      };
    }

    // 4) 路由映射 + 逐 KB 检索 + 合并去重（保持 routeKbIds 顺序，去重同分保留先到组）
    const routeKbIds = resolveRetrievalKbIds(intent, cfg, kbRows);
    const reqs = buildRetrievalRequests({
      query: rewrittenQuery,
      routeKbIds,
      embedModelId: kbRows[0]?.embeddingModelId ?? "",
      retrieval: cfg.retrieval,
    });
    const perKb = await Promise.all(
      reqs.map(async (r) => ({ kbId: r.kbId, hits: (await this.retrieval.test(r)).hits })),
    );
    const hits: TaggedHit[] = mergeHits(perKb).slice(0, cfg.retrieval.topN);

    // 5) 兜底判定：rerank 开启时用 rerankThreshold（缺省回退平台阈值）
    const threshold = cfg.retrieval.rerankEnabled
      ? (cfg.retrieval.rerankThreshold ?? FALLBACK_THRESHOLD)
      : FALLBACK_THRESHOLD;
    const scopeKbNames = routeKbIds.map((id) => kbNameById.get(id) ?? id);
    const decision = decideFallback({
      topScore: hits[0]?.finalScore,
      hitCount: hits.length,
      threshold,
      scopeKbNames,
    });
    const fallbackInfo: FallbackInfo = {
      reasons: decision.reasons,
      topScore: decision.topScore,
      threshold: decision.threshold,
      scopeKbNames: decision.scopeKbNames,
    };

    if (decision.isFallback) {
      return {
        branch: "fallback",
        citations: [],
        retrievalContext: "",
        history,
        validConvId,
        isFallback: true,
        reasons: decision.reasons,
        fallbackInfo,
      };
    }

    const citations: ChatCitation[] = hits.map((h, i) => ({
      n: i + 1,
      doc: h.docName,
      kb: kbNameById.get(h.kbId) ?? "",
      section: h.section,
      score: h.finalScore,
      text: h.text, // M8 T4：命中段正文回传前端右栏
    }));
    const retrievalContext = hits.map((h, i) => `[${i + 1}] ${h.text}`).join("\n\n");
    return {
      branch: "reply",
      citations,
      retrievalContext,
      history,
      validConvId,
      isFallback: false,
      reasons: [],
      fallbackInfo,
    };
  }

  /** 派生指标（F3：从正文 [n] 反查被引用 citation 的 score）+ 组装 OrchestrationResult（内部累加器）。 */
  private buildResult(traceId: string, replyText: string, prep: PrepResult): OrchestrationResult {
    const marks = new Set([...replyText.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
    const citedScores = prep.citations.filter((c) => marks.has(c.n)).map((c) => c.score);
    const confidence = prep.isFallback
      ? undefined
      : deriveConfidence(citedScores.length ? citedScores : prep.citations.slice(0, 1).map((c) => c.score));
    const coverage = deriveCoverage(replyText, prep.citations.length, prep.isFallback);
    return {
      traceId,
      replyText,
      citations: prep.citations,
      confidence,
      coverage,
      isFallback: prep.isFallback,
      fallbackReasons: prep.reasons,
      fallbackInfo: prep.fallbackInfo,
    };
  }

  private async executeNode<TOutput>(
    node: ResolvedNodeConfig,
    name: "rewrite" | "intent",
    input: Record<string, unknown>,
    reserved: unknown,
  ): Promise<TOutput> {
    const r = await this.nodeRuntime.executeStructured<Record<string, unknown>, TOutput, unknown>(
      name,
      node.contractVersion,
      node.promptBody,
      node.modelId,
      input,
      reserved,
      { temperature: node.temperature },
    );
    return r.output;
  }

  private async streamNode(
    node: ResolvedNodeConfig,
    name: "reply" | "fallback",
    payload: { input?: Record<string, unknown>; reserved?: unknown } = {},
  ): Promise<string> {
    const r = await this.nodeRuntime.streamText(
      name,
      node.contractVersion,
      node.promptBody,
      node.modelId,
      payload.input ?? {},
      payload.reserved ?? {},
      { temperature: node.temperature },
    );
    return r.text;
  }

  /**
   * review P2：校验 convId 归属当前 agentId，防跨应用会话读写（IDOR）——客户端自报的 convId
   * 若实际属于别的 agentId，会话历史不得被读进当前应用的提示词、也不得被追加消息。
   * 不存在/不属于/查询失败均按未传 convId 处理（降级新建会话），不冒泡为请求失败。
   */
  private async resolveConvId(agentId: string, convId?: string): Promise<string | undefined> {
    if (!convId) return undefined;
    try {
      const conv = await this.conversations.get(convId);
      if (conv.agentId !== agentId) {
        this.logger.warn(
          `convId ${convId} 不属于 agentId ${agentId}（实际属于 ${conv.agentId}）——拒绝跨应用复用，按新会话处理`,
        );
        return undefined;
      }
      return convId;
    } catch (err) {
      this.logger.warn(`convId ${convId} 校验失败（${(err as Error).message}），按新会话处理`);
      return undefined;
    }
  }

  /** 历史注入：读会话既有消息（尾部 N 条）拼接为 "role: content" 行；失败降级 undefined。 */
  private async loadHistory(convId?: string): Promise<string | undefined> {
    if (!convId) return undefined;
    try {
      const msgs = await this.conversations.listMessages(convId);
      if (msgs.length === 0) return undefined;
      return msgs
        .slice(-HISTORY_MAX_MESSAGES)
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n");
    } catch (err) {
      this.logger.warn(`加载会话历史失败（降级为无历史）：${(err as Error).message}`);
      return undefined;
    }
  }

  /** 落库（user+assistant）——边界 7：持久化异常兜住不冒泡为 500，降级仍返回回答。 */
  private async persist(
    result: OrchestrationResult,
    a: { agentId: string; query: string; convId?: string; userId?: string },
  ): Promise<string | undefined> {
    // review P3：convId 声明在 try 外层（非 const）——若 createConversation 已成功但后续
    // appendMessage 失败，catch 分支能返回这个刚创建的会话 id，而不是回退到调用方原始
    // 入参（新会话场景下是 undefined），避免已落库的会话在异常路径里“丢失”。
    let convId = a.convId;
    try {
      if (!convId) {
        convId = (
          await this.conversations.createConversation({
            agentId: a.agentId,
            userId: a.userId,
            title: a.query.slice(0, TITLE_MAX),
          })
        ).id;
      }
      await this.conversations.appendMessage({ convId, role: "user", content: a.query });
      await this.conversations.appendMessage({
        convId,
        role: "assistant",
        content: result.replyText,
        traceId: result.traceId,
        confidence: result.confidence,
        coverage: result.coverage,
        isFallback: result.isFallback,
        fallbackInfo: result.fallbackInfo,
        citations: result.citations.map((c) => String(c.n)),
      });
      return convId;
    } catch (err) {
      this.logger.error(`会话落库失败（降级继续返回回答）：${(err as Error).message}`);
      return convId;
    }
  }
}
