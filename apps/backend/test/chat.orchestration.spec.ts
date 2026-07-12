import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ChatStreamEventSchema } from "@codecrush/contracts";
import { ChatController } from "../src/modules/chat/chat.controller";
import type { OrchestrationService } from "../src/modules/chat/orchestration.service";
import type { OrchestrationResult } from "../src/modules/chat/orchestration.types";

/** 捕获 controller 合成的 SSE 字节流与响应头，供断言。 */
function fakeRes() {
  const headers: Record<string, string> = {};
  const chunks: string[] = [];
  let ended = false;
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
  };
}

const RESULT: OrchestrationResult = {
  traceId: "a".repeat(32),
  convId: "conv1",
  replyText: "答案[1][2]",
  citations: [
    { n: 1, doc: "a.pdf", kb: "售后库", section: "退货", score: 0.9 },
    { n: 2, doc: "b.pdf", kb: "通用库", section: "政策", score: 0.8 },
  ],
  confidence: 0.9,
  coverage: "full",
  isFallback: false,
  fallbackReasons: [],
  fallbackInfo: { reasons: [] },
};

function makeController(runImpl: OrchestrationService["run"]): ChatController {
  const orchestration = { run: runImpl } as unknown as OrchestrationService;
  return new ChatController(orchestration);
}

const REQ = { user: { id: "u1", email: "u@x" } };

describe("ChatController（接 OrchestrationService，合成 SSE）", () => {
  it("已上线应用 → 200 event-stream，含 citation×2 + token + 末位 done", async () => {
    const run = jest.fn(async () => RESULT);
    const res = fakeRes();
    await makeController(run as unknown as OrchestrationService["run"]).chat(
      { agentId: "aftersale", query: "怎么退货" } as never,
      REQ,
      res as never,
    );
    expect(run).toHaveBeenCalledWith("aftersale", "怎么退货", undefined, "u1");
    expect(res._headers["Content-Type"]).toMatch(/text\/event-stream/);
    expect(res._ended()).toBe(true);

    const events = res._events();
    for (const e of events) expect(() => ChatStreamEventSchema.parse(e)).not.toThrow();
    const types = events.map((e: { type: string }) => e.type);
    // citation×2 → token → done
    expect(types.filter((t: string) => t === "citation")).toHaveLength(2);
    expect(types).toContain("token");
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
    const token = events.find((e: { type: string }) => e.type === "token");
    expect(token.delta).toBe("答案[1][2]");
  });

  it("兜底结果 → done 带 isFallback=true + fallbackReasons，无 citation", async () => {
    const run = jest.fn(async () => ({
      ...RESULT,
      citations: [],
      confidence: undefined,
      coverage: "partial" as const,
      isFallback: true,
      fallbackReasons: ["low_similarity", "handled_by_fallback"] as never,
      replyText: "很抱歉，未找到相关答案。",
    }));
    const res = fakeRes();
    await makeController(run as unknown as OrchestrationService["run"]).chat(
      { agentId: "aftersale", query: "天书" } as never,
      REQ,
      res as never,
    );
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

  it("传 convId → 透传给 run", async () => {
    const run = jest.fn(async () => RESULT);
    const res = fakeRes();
    await makeController(run as unknown as OrchestrationService["run"]).chat(
      { agentId: "aftersale", query: "接着问", convId: "conv9" } as never,
      REQ,
      res as never,
    );
    expect(run).toHaveBeenCalledWith("aftersale", "接着问", "conv9", "u1");
  });

  it("未上线 → run 抛 NotFound 冒泡（未写 event-stream 头）", async () => {
    const run = jest.fn(async () => {
      throw new NotFoundException("应用未上线");
    });
    const res = fakeRes();
    await expect(
      makeController(run as unknown as OrchestrationService["run"]).chat(
        { agentId: "gone", query: "q" } as never,
        REQ,
        res as never,
      ),
    ).rejects.toThrow(NotFoundException);
    expect(res._headers["Content-Type"]).toBeUndefined();
    expect(res._ended()).toBe(false);
  });

  it("停用 → run 抛 Forbidden 冒泡", async () => {
    const run = jest.fn(async () => {
      throw new ForbiddenException("应用已停用");
    });
    const res = fakeRes();
    await expect(
      makeController(run as unknown as OrchestrationService["run"]).chat(
        { agentId: "disabled", query: "q" } as never,
        REQ,
        res as never,
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(res._headers["Content-Type"]).toBeUndefined();
  });
});
