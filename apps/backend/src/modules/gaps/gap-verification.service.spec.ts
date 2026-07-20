import type { ChatStreamEvent, ReplayScoresEvent } from "@codecrush/contracts";
import { GapVerificationService } from "./gap-verification.service";
import { GapVerificationNotifier } from "./gap-verification.notifier";
import type { GapsService } from "./gaps.service";
import type { GapsRepository } from "./gaps.repository";
import { DocumentChangeNotifier } from "../../platform/events/document-change.notifier";
import type { DocumentsRepository } from "../documents/documents.repository";
import type { ReplayService } from "../eval-runs/replay.service";

/**
 * 入库后自动回验（021 决策 K，原型 §9 `:370` / §18.C `:705-706`）。
 *
 * 断言落在**产出的状态迁移与分数**上。核心不变量有三条：
 *  ① 三分取 min，**任一为 null 则整体 null**（不能用 Math.min 把 null 当 0）；
 *  ② 「文档处理失败」与「补库后仍低分」是两回事——都回 `pending`，但只有后者打复发标；
 *  ③ 每个分支都必须把簇推离 `filled`——留在那儿就是没人会再管的死态。
 */

const CLUSTER = "11111111-1111-4111-8111-111111111111";
const DOC = "77777777-7777-4777-8777-777777777777";
const APP = "55555555-5555-4555-8555-555555555555";
const VERSION = "66666666-6666-4666-8666-666666666666";

type Scores = Pick<ReplayScoresEvent, "faithfulness" | "answerRelevancy" | "contextPrecision">;

interface Harness {
  service: GapVerificationService;
  /** 迁移记录，形如 `verifyPass:89` / `verifyFail:null` / `verifyIngestFailed`。 */
  transitions: string[];
  replayCalls: { question: string; applicationId: string; sourceTraceId: string }[];
}

function harness(
  options: {
    status?: string;
    documentStatus?: string | null;
    documentId?: string | null;
    applicationId?: string | null;
    scores?: Scores | null;
    replayError?: Error;
  } = {},
): Harness {
  const transitions: string[] = [];
  const replayCalls: Harness["replayCalls"] = [];

  const gaps = {
    mustFindForFill: async () => ({
      id: CLUSTER,
      status: options.status ?? "filled",
      representativeQuestion: "能开专用发票吗",
      fillDraftQuestion: null,
      fillDraftAnswer: null,
      fillTargetKbId: null,
      fillTargetDocumentId: options.documentId === undefined ? DOC : options.documentId,
      fillVerifyApplicationId: options.applicationId === undefined ? APP : options.applicationId,
      fillVerifyConfigVersionId: options.applicationId === undefined ? VERSION : null,
      fillPreScore: 41,
    }),
    recordVerifyPass: async (_id: string, score: number) => {
      transitions.push(`verifyPass:${score}`);
      return {} as never;
    },
    recordVerifyFail: async (_id: string, score: number) => {
      transitions.push(`verifyFail:${score}`);
      return {} as never;
    },
    recordVerifyInconclusive: async () => {
      transitions.push("verifyInconclusive");
      return {} as never;
    },
    recordVerifyIngestFailed: async () => {
      transitions.push("verifyIngestFailed");
      return {} as never;
    },
  } as unknown as GapsService;

  const documents = {
    findById: async () =>
      options.documentStatus === null
        ? undefined
        : { id: DOC, status: options.documentStatus ?? "ready" },
  } as unknown as DocumentsRepository;

  const replay = {
    stream: async function* (req: {
      question: string;
      applicationId: string;
      sourceTraceId: string;
    }): AsyncGenerator<ChatStreamEvent | ReplayScoresEvent> {
      replayCalls.push({
        question: req.question,
        applicationId: req.applicationId,
        sourceTraceId: req.sourceTraceId,
      });
      if (options.replayError) throw options.replayError;
      yield { type: "token", delta: "回答" } as ChatStreamEvent;
      if (options.scores !== null && options.scores !== undefined) {
        yield { type: "replay_scores", ...options.scores, evidence: {} } as ReplayScoresEvent;
      }
    },
  } as unknown as ReplayService;

  return {
    service: new GapVerificationService(gaps, replay, documents),
    transitions,
    replayCalls,
  };
}

describe("GapVerificationService.verifyCluster", () => {
  it("三分都 ≥80 → verified，记的是三者的最小值（与屏5 avgQuality 同口径）", async () => {
    const h = harness({ scores: { faithfulness: 92, answerRelevancy: 85, contextPrecision: 89 } });
    await h.service.verifyCluster(CLUSTER);
    expect(h.transitions).toEqual(["verifyPass:85"]);
  });

  it("恰好 80 通过（阈值是 ≥，不是 >）", async () => {
    const h = harness({ scores: { faithfulness: 80, answerRelevancy: 95, contextPrecision: 95 } });
    await h.service.verifyCluster(CLUSTER);
    expect(h.transitions).toEqual(["verifyPass:80"]);
  });

  it("最低分 <80 → 回 pending 并记新分数（屏5 显示「补库后仍低分」）", async () => {
    const h = harness({ scores: { faithfulness: 95, answerRelevancy: 62, contextPrecision: 90 } });
    await h.service.verifyCluster(CLUSTER);
    expect(h.transitions).toEqual(["verifyFail:62"]);
  });

  it("任一指标未评（null）→ 判「测不出」而**不是**低分——更不当成 0 分", async () => {
    // 用 Math.min 的话 null 会被当 0，一条本可能通过的回验被判成惨败。
    // 且走 verifyInconclusive 而非 verifyFail：没测出来不该打复发标。
    const h = harness({
      scores: { faithfulness: null, answerRelevancy: 95, contextPrecision: 92 },
    });
    await h.service.verifyCluster(CLUSTER);
    expect(h.transitions).toEqual(["verifyInconclusive"]);
  });

  it("没有 replay_scores 帧（裁判未配置/答案为空）→ verifyInconclusive，**不打复发标**", async () => {
    // 判官 API key 过期时，若这里走 verifyFail，运营看到的是「这批缺口全复发了」，
    // 而真相是「我们一个都没测成」——工程故障不该伪装成业务信号。
    const h = harness({ scores: null });
    await h.service.verifyCluster(CLUSTER);
    expect(h.transitions).toEqual(["verifyInconclusive"]);
  });

  it("重放抛错 → verifyInconclusive，不把异常冒出去", async () => {
    const h = harness({ replayError: new Error("orchestration down") });
    await expect(h.service.verifyCluster(CLUSTER)).resolves.toBeUndefined();
    expect(h.transitions).toEqual(["verifyInconclusive"]);
  });

  it("文档处理失败 → verifyIngestFailed，**不**打复发标、也不跑重放", async () => {
    // 工程故障 ≠ 缺口复发。两者都回 pending，但 UI 文案与后续动作不同。
    const h = harness({ documentStatus: "failed" });
    await h.service.verifyCluster(CLUSTER);
    expect(h.transitions).toEqual(["verifyIngestFailed"]);
    expect(h.replayCalls).toEqual([]);
  });

  it("文档还没 ready → 什么都不做，等下一次事件（不把时序意外变成错误结论）", async () => {
    const h = harness({ documentStatus: "processing" });
    await h.service.verifyCluster(CLUSTER);
    expect(h.transitions).toEqual([]);
    expect(h.replayCalls).toEqual([]);
  });

  it("簇已不是 filled → 幂等返回（文档事件是 fan-out，同一份文档会通知多次）", async () => {
    for (const status of ["pending", "verified", "ignored", "reviewing"]) {
      const h = harness({ status });
      await h.service.verifyCluster(CLUSTER);
      expect(h.transitions).toEqual([]);
      expect(h.replayCalls).toEqual([]);
    }
  });

  it("filled 却没有 documentId（数据坏了）→ 按入库失败处理，让用户能重走向导", async () => {
    const h = harness({ documentId: null });
    await h.service.verifyCluster(CLUSTER);
    // 关键是**别把簇留在 filled**：那是个没人会再管的死态。
    expect(h.transitions).toEqual(["verifyIngestFailed"]);
  });

  it("filled 却没有回验用的应用/版本 → verifyInconclusive（数据坏了不是缺口复发）", async () => {
    const h = harness({ applicationId: null });
    await h.service.verifyCluster(CLUSTER);
    expect(h.transitions).toEqual(["verifyInconclusive"]);
  });

  it("重放用簇的代表问题，且每次 sourceTraceId 都不同（绕开 60s 限频）", async () => {
    // 限频是防「用户狂点重放」的；系统回验被它拦下会让第二次补库的回验无声变成「未通过」。
    const a = harness({ scores: { faithfulness: 90, answerRelevancy: 90, contextPrecision: 90 } });
    await a.service.verifyCluster(CLUSTER);
    const b = harness({ scores: { faithfulness: 90, answerRelevancy: 90, contextPrecision: 90 } });
    await b.service.verifyCluster(CLUSTER);

    expect(a.replayCalls[0].question).toBe("能开专用发票吗");
    expect(a.replayCalls[0].applicationId).toBe(APP);
    // 32 位十六进制（`ReplayRequestSchema` 的硬约束），且两次不同。
    expect(a.replayCalls[0].sourceTraceId).toMatch(/^[a-f0-9]{32}$/);
    expect(a.replayCalls[0].sourceTraceId).not.toBe(b.replayCalls[0].sourceTraceId);
  });
});

describe("GapVerificationNotifier", () => {
  function notifierHarness(cluster: { id: string; status: string } | undefined) {
    let registered: ((docId: string) => Promise<void>) | null = null;
    const lookups: string[] = [];
    const verified: string[] = [];

    const notifier = new GapVerificationNotifier(
      { registerTerminal: (fn: (docId: string) => Promise<void>) => (registered = fn) } as never,
      {
        findClusterByFillTargetDocument: async (docId: string) => {
          lookups.push(docId);
          return cluster;
        },
      } as unknown as GapsRepository,
      {
        verifyCluster: async (id: string) => {
          verified.push(id);
        },
      } as unknown as GapVerificationService,
    );
    notifier.onModuleInit();
    return { fire: (docId: string) => registered!(docId), lookups, verified };
  }

  it("文档事件命中等待中的簇 → 触发回验", async () => {
    const h = notifierHarness({ id: CLUSTER, status: "filled" });
    await h.fire(DOC);
    expect(h.lookups).toEqual([DOC]);
    expect(h.verified).toEqual([CLUSTER]);
  });

  it("与问题池无关的文档 → 一次窄查询后立刻返回（广播是 fan-out，绝大多数都无关）", async () => {
    const h = notifierHarness(undefined);
    await h.fire("some-other-doc");
    expect(h.verified).toEqual([]);
  });

  it("回验抛错只记日志、不冒泡——绝不让补库的附加动作打回一次正常的文档解析", async () => {
    let registered: ((docId: string) => Promise<void>) | null = null;
    const notifier = new GapVerificationNotifier(
      { registerTerminal: (fn: (docId: string) => Promise<void>) => (registered = fn) } as never,
      {
        findClusterByFillTargetDocument: async () => ({ id: CLUSTER, status: "filled" }),
      } as unknown as GapsRepository,
      {
        verifyCluster: async () => {
          throw new Error("judge exploded");
        },
      } as unknown as GapVerificationService,
    );
    notifier.onModuleInit();

    await expect(registered!(DOC)).resolves.toBeUndefined();
  });
});

/**
 * **接线**测试：用**真的** `DocumentChangeNotifier` 把 ingestion 的广播接到回验监听器上。
 *
 * 为什么单开这一组：上面所有用例都直接调 `verifyCluster`，因此对「监听器订阅了哪条通道」
 * 完全无感。初版把回验挂在 `notifyChanged` 上，而那条通道**只在 ready 广播**
 * （它服务的是 gold 过期检测，失败时内容没变、报过期是假阳性）——于是一份解析失败的
 * 补库文档永远不会通知任何人，等它的簇永久卡在 `filled`，而 `verifyCluster` 里那条
 * `failed → verifyIngestFailed` 分支**永不可达**。整套单测全绿，peer review 才抓出来。
 */
describe("回验监听器与文档广播的接线", () => {
  function wire(documentStatus: "ready" | "failed") {
    const verified: string[] = [];
    const changes = new DocumentChangeNotifier();
    const notifier = new GapVerificationNotifier(
      changes,
      {
        findClusterByFillTargetDocument: async () => ({ id: CLUSTER, status: "filled" }),
      } as unknown as GapsRepository,
      {
        verifyCluster: async (id: string) => {
          verified.push(id);
        },
      } as unknown as GapVerificationService,
    );
    notifier.onModuleInit();
    return { changes, verified, documentStatus };
  }

  it("文档 ready → 回验被触发", async () => {
    const w = wire("ready");
    await w.changes.notifyTerminal(DOC, "ready");
    expect(w.verified).toEqual([CLUSTER]);
  });

  it("文档 **failed** → 回验同样被触发（否则簇永久卡在 filled）", async () => {
    const w = wire("failed");
    await w.changes.notifyTerminal(DOC, "failed");
    expect(w.verified).toEqual([CLUSTER]);
  });

  it("**不**订阅「内容变更」通道——那条只在 ready 发，挂上去等于放弃 failed 这一半", async () => {
    const w = wire("ready");
    await w.changes.notifyChanged(DOC);
    expect(w.verified).toEqual([]);
  });
});
