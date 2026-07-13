import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ChatStreamEventSchema, type ChatStreamEvent } from "@codecrush/contracts";
import { ChatController } from "../src/modules/chat/chat.controller";
import type { OrchestrationService } from "../src/modules/chat/orchestration.service";

/** 捕获 controller 合成的 SSE 字节流、响应头与 close 侦听，供断言。 */
function fakeRes() {
  const headers: Record<string, string> = {};
  const chunks: string[] = [];
  let ended = false;
  let closeCb: (() => void) | undefined;
  return {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    write: (c: string) => {
      chunks.push(c);
      return true;
    },
    end: () => {
      ended = true;
    },
    on: (event: string, cb: () => void) => {
      if (event === "close") closeCb = cb;
    },
    // 断言辅助
    _headers: headers,
    _events: () =>
      chunks
        .join("")
        .split("\n\n")
        .map((s) => s.trim())
        .filter((s) => s.startsWith("data: "))
        .map((s) => JSON.parse(s.slice("data: ".length))),
    _ended: () => ended,
    _fireClose: () => closeCb?.(),
  };
}

/** 把事件数组包成 async generator，模拟 OrchestrationService.run。 */
function genRun(events: ChatStreamEvent[]): OrchestrationService["run"] {
  return jest.fn(async function* () {
    for (const e of events) yield e;
  }) as unknown as OrchestrationService["run"];
}

const NORMAL_EVENTS: ChatStreamEvent[] = [
  { type: "citation", citation: { n: 1, doc: "a.pdf", kb: "售后库", section: "退货", score: 0.9 } },
  { type: "citation", citation: { n: 2, doc: "b.pdf", kb: "通用库", section: "政策", score: 0.8 } },
  { type: "token", delta: "答案" },
  { type: "token", delta: "[1][2]" },
  { type: "done", traceId: "a".repeat(32), confidence: 0.9, coverage: "full", isFallback: false, fallbackReasons: [] },
];

function makeController(runImpl: OrchestrationService["run"]): ChatController {
  const orchestration = { run: runImpl } as unknown as OrchestrationService;
  return new ChatController(orchestration);
}

const REQ = { user: { id: "u1", email: "u@x" } };

describe("ChatController（消费 SSE generator，逐帧 flush）", () => {
  it("已上线应用 → 200 event-stream，逐 token 多帧 + 末位 done", async () => {
    const run = genRun(NORMAL_EVENTS);
    const res = fakeRes();
    await makeController(run).chat({ agentId: "aftersale", query: "怎么退货" } as never, REQ, res as never);
    expect(run).toHaveBeenCalledWith("aftersale", "怎么退货", undefined, "u1");
    expect(res._headers["Content-Type"]).toMatch(/text\/event-stream/);
    expect(res._ended()).toBe(true);

    const events = res._events();
    for (const e of events) expect(() => ChatStreamEventSchema.parse(e)).not.toThrow();
    const types = events.map((e: { type: string }) => e.type);
    // citation×2 → token×2（逐 token） → done
    expect(types.filter((t: string) => t === "citation")).toHaveLength(2);
    expect(types.filter((t: string) => t === "token")).toHaveLength(2);
    expect(types[types.length - 1]).toBe("done");

    const done = events[events.length - 1];
    expect(done).toMatchObject({
      type: "done",
      traceId: "a".repeat(32),
      confidence: 0.9,
      coverage: "full",
      isFallback: false,
      fallbackReasons: [],
    });
    const tokenDeltas = events
      .filter((e: { type: string }) => e.type === "token")
      .map((e: { delta: string }) => e.delta);
    expect(tokenDeltas.join("")).toBe("答案[1][2]");
  });

  it("兜底结果 → done 带 isFallback=true + fallbackReasons，无 citation", async () => {
    const run = genRun([
      { type: "token", delta: "很抱歉，未找到相关答案。" },
      {
        type: "done",
        traceId: "a".repeat(32),
        coverage: "partial",
        isFallback: true,
        fallbackReasons: ["low_similarity", "handled_by_fallback"],
      },
    ]);
    const res = fakeRes();
    await makeController(run).chat({ agentId: "aftersale", query: "天书" } as never, REQ, res as never);
    const events = res._events();
    expect(events.filter((e: { type: string }) => e.type === "citation")).toHaveLength(0);
    const done = events[events.length - 1];
    expect(done).toMatchObject({
      type: "done",
      isFallback: true,
      coverage: "partial",
      fallbackReasons: ["low_similarity", "handled_by_fallback"],
    });
    expect(done.confidence).toBeUndefined();
  });

  it("首 token 超时 → error 事件（无 done），字节流合法", async () => {
    const run = genRun([{ type: "error", message: "生成超时，请稍后重试" }]);
    const res = fakeRes();
    await makeController(run).chat({ agentId: "aftersale", query: "q" } as never, REQ, res as never);
    const events = res._events();
    for (const e of events) expect(() => ChatStreamEventSchema.parse(e)).not.toThrow();
    expect(events.map((e: { type: string }) => e.type)).toEqual(["error"]);
    expect(res._ended()).toBe(true);
  });

  it("传 convId → 透传给 run", async () => {
    const run = genRun(NORMAL_EVENTS);
    const res = fakeRes();
    await makeController(run).chat(
      { agentId: "aftersale", query: "接着问", convId: "conv9" } as never,
      REQ,
      res as never,
    );
    expect(run).toHaveBeenCalledWith("aftersale", "接着问", "conv9", "u1");
  });

  it("未上线 → 首个 next() 抛 NotFound 冒泡（未写 event-stream 头）", async () => {
    const run = jest.fn(async function* (): AsyncGenerator<ChatStreamEvent> {
      throw new NotFoundException("应用未上线");
    }) as unknown as OrchestrationService["run"];
    const res = fakeRes();
    await expect(
      makeController(run).chat({ agentId: "gone", query: "q" } as never, REQ, res as never),
    ).rejects.toThrow(NotFoundException);
    expect(res._headers["Content-Type"]).toBeUndefined();
    expect(res._ended()).toBe(false);
  });

  it("停用 → 首个 next() 抛 Forbidden 冒泡", async () => {
    const run = jest.fn(async function* (): AsyncGenerator<ChatStreamEvent> {
      throw new ForbiddenException("应用已停用");
    }) as unknown as OrchestrationService["run"];
    const res = fakeRes();
    await expect(
      makeController(run).chat({ agentId: "disabled", query: "q" } as never, REQ, res as never),
    ).rejects.toThrow(ForbiddenException);
    expect(res._headers["Content-Type"]).toBeUndefined();
  });

  it("客户端断连（res close）→ 触发 gen.return()", async () => {
    let returned = false;
    const run = jest.fn(() => {
      const inner = (async function* (): AsyncGenerator<ChatStreamEvent> {
        yield { type: "token", delta: "a" };
        yield { type: "token", delta: "b" };
      })();
      const orig = inner.return.bind(inner);
      inner.return = ((v?: unknown) => {
        returned = true;
        return orig(v as never);
      }) as never;
      return inner;
    }) as unknown as OrchestrationService["run"];
    const res = fakeRes();
    const p = makeController(run).chat({ agentId: "x", query: "q" } as never, REQ, res as never);
    res._fireClose(); // 模拟客户端断连
    await p;
    expect(returned).toBe(true);
  });
});
