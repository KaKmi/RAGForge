import { HttpException } from "@nestjs/common";
import type { ChatStreamEvent, ReplayRequest } from "@codecrush/contracts";
import { ReplayService } from "../src/modules/eval-runs/replay.service";
import type { OrchestrationService } from "../src/modules/chat/orchestration.service";
import type { ApplicationsService } from "../src/modules/applications/applications.service";
import type { EvaluationJudgeService } from "../src/modules/evaluations/evaluation-judge.service";
import type { EvaluationsRepository } from "../src/modules/evaluations/evaluations.repository";

/**
 * E-W2b F7：重放 SSE + 即时判分 + 限频。分数只走 SSE 帧，绝不落存储/发 span。
 */

const UUID = "11111111-1111-4111-8111-111111111111";
const req = (over: Partial<ReplayRequest> = {}): ReplayRequest => ({
  applicationId: UUID,
  configVersionId: UUID,
  question: "怎么退款",
  sourceTraceId: "a".repeat(32),
  ...over,
});

interface Opts {
  frames?: ChatStreamEvent[];
  resolveThrows?: boolean;
  settings?: { judgeModelId: string | null; embeddingModelId: string | null };
  scoreThrows?: boolean;
}

function setup(opts: Opts = {}) {
  const frames = opts.frames ?? [
    { type: "token", delta: "答案" },
    { type: "done", traceId: "t1", confidence: 1, coverage: "full", isFallback: false, fallbackReasons: [] },
  ];
  const runForReplay = jest.fn(async function* (
    _cfg: unknown,
    _q: string,
    o: { onPrep?: (p: { hits: unknown[] }) => void },
  ) {
    o.onPrep?.({ hits: [{ chunkId: "c1", text: "ctx", finalScore: 0.9 }] });
    for (const f of frames) yield f;
  });
  const orchestration = { runForReplay } as unknown as OrchestrationService;
  const applications = {
    resolveForTest: jest.fn(async () => {
      if (opts.resolveThrows) throw new Error("版本停用");
      return { applicationId: UUID, configVersionId: UUID, version: 1 };
    }),
  } as unknown as ApplicationsService;
  const scoreOffline = jest.fn(async () => ({
    faithfulness: 88,
    answerRelevancy: 90,
    contextPrecision: 75,
    correctness: null,
    citation: null,
    evidence: { faithfulness: ["ok"] },
    usage: { inputTokens: 0, outputTokens: 0 },
  }));
  if (opts.scoreThrows) scoreOffline.mockRejectedValue(new Error("judge down"));
  const judge = { scoreOffline } as unknown as EvaluationJudgeService;
  const evaluations = {
    getSettings: jest.fn(async () => opts.settings ?? { judgeModelId: UUID, embeddingModelId: UUID }),
  } as unknown as EvaluationsRepository;

  const service = new ReplayService(orchestration, applications, judge, evaluations);
  return { service, scoreOffline, applications };
}

async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("ReplayService.stream", () => {
  it("happy：token…done 后追发 replay_scores（三分），correctness 不调（goldPoints=[]）", async () => {
    const { service, scoreOffline } = setup();
    const events = (await drain(service.stream(req(), "actor"))) as Array<{ type: string }>;
    expect(events.map((e) => e.type)).toEqual(["token", "done", "replay_scores"]);
    const scores = events.find((e) => e.type === "replay_scores") as Record<string, unknown>;
    expect(scores.faithfulness).toBe(88);
    // goldPoints 空数组透传（correctness 不调）。
    expect(scoreOffline.mock.calls[0][2]).toEqual([]);
  });

  it("裁判未配置（judgeModelId null）→ 无 replay_scores 帧，流正常结束", async () => {
    const { service, scoreOffline } = setup({ settings: { judgeModelId: null, embeddingModelId: UUID } });
    const events = (await drain(service.stream(req(), "actor"))) as Array<{ type: string }>;
    expect(events.map((e) => e.type)).toEqual(["token", "done"]);
    expect(scoreOffline).not.toHaveBeenCalled();
  });

  it("答案为空 → 不判分", async () => {
    const { service, scoreOffline } = setup({
      frames: [{ type: "done", traceId: "t1", confidence: 1, coverage: "none", isFallback: true, fallbackReasons: [] }],
    });
    await drain(service.stream(req(), "actor"));
    expect(scoreOffline).not.toHaveBeenCalled();
  });

  it("error 事件 → 不判分", async () => {
    const { service, scoreOffline } = setup({
      frames: [{ type: "token", delta: "半句" }, { type: "error", message: "生成失败" }],
    });
    await drain(service.stream(req(), "actor"));
    expect(scoreOffline).not.toHaveBeenCalled();
  });

  it("判分失败 → 不发 replay_scores 帧（不阻塞主流）", async () => {
    const { service } = setup({ scoreThrows: true });
    const events = (await drain(service.stream(req(), "actor"))) as Array<{ type: string }>;
    expect(events.map((e) => e.type)).toEqual(["token", "done"]);
  });

  it("限频：同 sourceTraceId 60s 内二次 → 429 文案逐字；不同 traceId 不互斥", async () => {
    const { service } = setup();
    await drain(service.stream(req(), "actor"));
    // 第二次同 traceId：首个 next() 抛 429（逐字文案）。
    await expect(service.stream(req(), "actor").next()).rejects.toThrow(
      "操作过于频繁，请 1 分钟后再试",
    );
    await expect(service.stream(req(), "actor").next()).rejects.toMatchObject({ status: 429 });
    // 不同 traceId 放行。
    const other = await drain(service.stream(req({ sourceTraceId: "b".repeat(32) }), "actor"));
    expect(other.length).toBeGreaterThan(0);
  });

  it("resolveForTest 抛 → 422「该版本已不可用」", async () => {
    const { service } = setup({ resolveThrows: true });
    const gen = service.stream(req(), "actor");
    await expect(gen.next()).rejects.toBeInstanceOf(HttpException);
    await expect(service.stream(req({ sourceTraceId: "c".repeat(32) }), "actor").next()).rejects.toThrow(
      "该版本已不可用",
    );
  });
});
