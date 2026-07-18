import type { ResolvedApplicationConfig, RetrievalHit } from "@codecrush/contracts";
import { OrchestrationService } from "../src/modules/chat/orchestration.service";
import type { ApplicationsService } from "../src/modules/applications/applications.service";
import type { NodeRuntimeService } from "../src/modules/node-runtime/executor/node-runtime.service";
import type { RetrievalService } from "../src/modules/retrieval/retrieval.service";
import type { KnowledgeBasesService } from "../src/modules/knowledge-bases/knowledge-bases.service";
import type { ConversationsService } from "../src/modules/conversations/conversations.service";

/**
 * E-W2b F1（018 缺口 9 收口）：`runForEvaluation` 超时时**硬中断**在途模型调用——
 * timeoutMs 成为真墙钟上限，不再由 provider HTTP 超时兜底。
 * AC1-1：fake provider 挂起、timeoutMs=300ms → <1s 返回 timedOut:true，0 次 unhandledRejection。
 */

function cfg(): ResolvedApplicationConfig {
  const node = (promptBody: string) => ({
    promptVersionId: "pv1",
    promptBody,
    contractVersion: 1,
    modelId: "m1",
    freedom: "balanced" as const,
    temperature: 0.7,
    topP: 1,
  });
  return {
    applicationId: "app1",
    slug: "aftersale",
    name: "售后助手",
    configVersionId: "cv1",
    version: 1,
    kbIds: ["kb_a"],
    nodes: {
      rewrite: node("改写正文"),
      intent: node("意图正文"),
      reply: node("回复正文"),
      fallback: node("很抱歉，没有找到相关答案。"),
    },
    retrieval: {
      schemaVersion: 1,
      topK: 10,
      topN: 5,
      hybridEnabled: true,
      vectorWeight: 0.7,
      rerankEnabled: false,
    },
    fallback: { toHuman: true },
    preview: true,
  };
}

function hit(chunkId: string): RetrievalHit {
  return {
    chunkId,
    docId: `doc_${chunkId}`,
    docName: `${chunkId}.pdf`,
    text: `内容 ${chunkId}`,
    section: `节 ${chunkId}`,
    vecScore: 0.9,
    finalScore: 0.9,
  };
}

const KB_ROWS = [{ id: "kb_a", name: "售后库", desc: "", embeddingModelId: "emb1", intentKey: "SUPPORT" }];

interface NodeOpts {
  signal?: AbortSignal;
}

function makeSvc(hangRewrite: boolean): { svc: OrchestrationService } {
  const applications = { resolvePublic: jest.fn(async () => cfg()) };
  const nodeRuntime = {
    executeStructured: jest.fn(
      async (
        node: string,
        _cv: number,
        _pb: string,
        _mid: string,
        _in: unknown,
        _res: unknown,
        options?: NodeOpts,
      ) => {
        if (node === "rewrite" && hangRewrite) {
          // 挂起直到外部 signal 中止（模拟 provider 长悬挂）。
          return await new Promise((_resolve, reject) => {
            const signal = options?.signal;
            if (signal?.aborted) return reject(new Error("节点执行被中止"));
            signal?.addEventListener("abort", () => reject(new Error("请求被中止")));
          });
        }
        return {
          output:
            node === "rewrite" ? { rewrittenQuery: "改写", keywords: [] } : { intent: "SUPPORT" },
          fallbackUsed: false,
          validateSteps: [],
          usage: { inputTokens: 5, outputTokens: 3 },
        };
      },
    ),
    streamTextChunks: jest.fn(async function* () {
      yield { delta: "答案" };
      return {
        outcome: "ok",
        text: "答案",
        usage: { inputTokens: 20, outputTokens: 15 },
        model: "deepseek-chat",
      };
    }),
    streamText: jest.fn(async () => ({ text: "兜底", fallbackUsed: false })),
  };
  const retrieval = { test: jest.fn(async () => ({ hits: [hit("a1")] })) };
  const kbs = { findByIds: jest.fn(async () => KB_ROWS) };
  const conversations = {
    get: jest.fn(async (id: string) => ({ id, agentId: "app1", title: "t", updatedAt: "" })),
    listMessages: jest.fn(async () => []),
  };
  const svc = new OrchestrationService(
    applications as unknown as ApplicationsService,
    nodeRuntime as unknown as NodeRuntimeService,
    retrieval as unknown as RetrievalService,
    kbs as unknown as KnowledgeBasesService,
    conversations as unknown as ConversationsService,
  );
  return { svc };
}

describe("runForEvaluation 硬中断（F1）", () => {
  it("AC1-1：provider 挂起 + timeoutMs=300 → <1s 返回 timedOut:true，无 unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const onRejection = (r: unknown) => rejections.push(r);
    process.on("unhandledRejection", onRejection);
    try {
      const { svc } = makeSvc(true);
      const start = Date.now();
      const outcome = await svc.runForEvaluation(cfg(), "怎么退款", {
        runId: "r1",
        timeoutMs: 300,
      });
      const elapsed = Date.now() - start;
      expect(outcome.timedOut).toBe(true);
      expect(elapsed).toBeLessThan(1000);
      // 让可能的微任务落地后再断言 0 次未捕获拒绝。
      await new Promise((r) => setTimeout(r, 50));
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("AC1-2/正常：不挂起时快速完成 → timedOut:false，收集到 token", async () => {
    const { svc } = makeSvc(false);
    const outcome = await svc.runForEvaluation(cfg(), "怎么退款", {
      runId: "r1",
      timeoutMs: 5000,
    });
    expect(outcome.timedOut).toBe(false);
    expect(outcome.replyText).toContain("答案");
    // F2：检索列表带出（retrievalExecuted=true）。
    expect(outcome.retrievalExecuted).toBe(true);
    expect(outcome.retrievedHits.length).toBeGreaterThan(0);
  });
});
