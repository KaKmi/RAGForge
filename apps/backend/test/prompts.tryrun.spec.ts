import {
  BadGatewayException,
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PromptsService } from "../src/modules/prompts/prompts.service";
import type { PromptsRepository, PromptListRow } from "../src/modules/prompts/prompts.repository";
import {
  UnsupportedChatProtocolError,
  type NodeRuntimeService,
} from "../src/modules/node-runtime/executor/node-runtime.service";
import type { PromptVersionRow } from "../src/modules/prompts/schema";

// M8.0 Story 8：try-run 分支矩阵——版本归属 / 编译错误 422 / refApplicationId 门控 /
// rewrite·intent 走 NodeRuntime 真实结构化 / 字段要求 / NodeRuntime 错误映射

const now = new Date("2026-07-01T00:00:00.000Z");
const replyPrompt: PromptListRow = {
  id: "p1",
  name: "回复生成-通用",
  node: "reply",
  updatedBy: "u@x",
  createdAt: now,
  updatedAt: now,
  latestVersionId: "pv1",
  latestVersion: 1,
  latestVariables: ["query"],
  versionCount: 1,
};
const version: PromptVersionRow = {
  id: "pv1",
  promptId: "p1",
  version: 1,
  body: "依据 {retrievalContext} 回答 {query}，历史：{history}",
  variables: ["retrievalContext", "query", "history"],
  contractVersion: 1,
  compileStatus: "ok",
  compileErrors: [],
  note: null,
  author: "u@x",
  createdAt: now,
};

const baseReq = {
  modelId: "m1",
  testVars: { query: "怎么退货" },
};

function makeService(over: {
  prompt?: Partial<PromptListRow>;
  version?: Partial<PromptVersionRow> | null;
  executeStructured?: jest.Mock;
  streamText?: jest.Mock;
}) {
  const repo = {
    findPromptById: jest.fn(async () => ({ ...replyPrompt, ...over.prompt })),
    findVersionById: jest.fn(async () =>
      over.version === null ? undefined : { ...version, ...over.version },
    ),
  } as unknown as PromptsRepository;
  const executeStructured =
    over.executeStructured ??
    jest.fn(async () => ({ output: {}, fallbackUsed: false, validateSteps: [] }));
  const streamText =
    over.streamText ?? jest.fn(async () => ({ text: "模型输出", fallbackUsed: false }));
  const nodeRuntime = { executeStructured, streamText } as unknown as NodeRuntimeService;
  return { service: new PromptsService(repo, nodeRuntime), executeStructured, streamText };
}

describe("PromptsService.tryRun · 前置校验", () => {
  it("版本不属于该 Prompt → 404，不触达 NodeRuntime", async () => {
    const { service, streamText } = makeService({ version: { promptId: "other" } });
    await expect(service.tryRun("p1", "pv1", baseReq)).rejects.toBeInstanceOf(NotFoundException);
    expect(streamText).not.toHaveBeenCalled();
  });

  it("存量 compile_status=has_errors → 422，不调用 NodeRuntime", async () => {
    const { service, streamText } = makeService({ version: { compileStatus: "has_errors" } });
    await expect(service.tryRun("p1", "pv1", baseReq)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(streamText).not.toHaveBeenCalled();
  });

  it("refApplicationId 非空 → unavailable/application_context_not_available（009 依赖门控）", async () => {
    const { service, streamText } = makeService({});
    const res = await service.tryRun("p1", "pv1", { ...baseReq, refApplicationId: "app-1" });
    expect(res).toEqual({ mode: "unavailable", reason: "application_context_not_available" });
    expect(streamText).not.toHaveBeenCalled();
  });

  it("reply 缺 query → 400；fallback 无需任何字段", async () => {
    const { service } = makeService({});
    await expect(
      service.tryRun("p1", "pv1", { modelId: "m1", testVars: { query: "  " } }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const fb = makeService({ prompt: { node: "fallback" }, version: { body: "固定话术" } });
    await expect(
      fb.service.tryRun("p1", "pv1", { modelId: "m1", testVars: { query: "" } }),
    ).resolves.toMatchObject({ mode: "text" });
  });
});

describe("PromptsService.tryRun · rewrite/intent 走 NodeRuntime.executeStructured", () => {
  it("rewrite 节点：调用 executeStructured，返回 structured，temperature 透传", async () => {
    const executeStructured = jest.fn(async () => ({
      output: { rewrittenQuery: "改写后", keywords: [] },
      fallbackUsed: false,
      validateSteps: [{ step: "input", ok: true }],
    }));
    const { service } = makeService({ prompt: { node: "rewrite" }, executeStructured });
    const res = await service.tryRun("p1", "pv1", { ...baseReq, temperature: 1.2 });
    expect(res).toEqual({
      mode: "structured",
      fields: { rewrittenQuery: "改写后", keywords: [] },
      validateSteps: [{ step: "input", ok: true }],
      fallbackUsed: false,
    });
    expect(executeStructured.mock.calls[0][6]).toEqual({ temperature: 1.2 });
  });

  it("intent 节点：调用 executeStructured 时 reserved 传入空 availableRoutes（试运行无真实应用上下文）", async () => {
    const executeStructured = jest.fn(async () => ({
      output: { intent: "unknown", routeIds: [], confidence: 0 },
      fallbackUsed: true,
      validateSteps: [],
    }));
    const { service } = makeService({ prompt: { node: "intent" }, executeStructured });
    await service.tryRun("p1", "pv1", baseReq);
    expect(executeStructured.mock.calls[0][5]).toEqual({ availableRoutes: [] });
  });
});

describe("PromptsService.tryRun · reply/fallback 走 NodeRuntime.streamText", () => {
  it("reply 成功：调用 streamText，temperature 透传，返回 mode:text", async () => {
    const streamText = jest.fn(async () => ({ text: "模型输出", fallbackUsed: false }));
    const { service } = makeService({ streamText });
    const res = await service.tryRun("p1", "pv1", {
      modelId: "m1",
      temperature: 1.2,
      testVars: { query: "怎么退货", retrievalContext: "第二条 七天无理由" },
    });
    expect(res).toEqual({ mode: "text", text: "模型输出" });
    expect(streamText.mock.calls[0][6]).toEqual({ temperature: 1.2 });
  });

  it("fallback 成功：正文直接返回，运行输入为空", async () => {
    const streamText = jest.fn(async () => ({ text: "兜底文案", fallbackUsed: false }));
    const { service } = makeService({
      prompt: { node: "fallback" },
      version: { body: "兜底文案" },
      streamText,
    });
    const res = await service.tryRun("p1", "pv1", {
      modelId: "m1",
      testVars: { query: "" },
    });
    expect(res.mode).toBe("text");
    expect(streamText.mock.calls[0][4]).toEqual({});
  });
});

describe("PromptsService.tryRun · NodeRuntime 错误映射", () => {
  it("协议不在矩阵 → NodeRuntime 抛 UnsupportedChatProtocolError → unavailable/unsupported_protocol", async () => {
    const streamText = jest.fn(async () => {
      throw new UnsupportedChatProtocolError("protocol cohere 不支持");
    });
    const { service } = makeService({ streamText });
    const res = await service.tryRun("p1", "pv1", baseReq);
    expect(res).toEqual({ mode: "unavailable", reason: "unsupported_protocol" });
  });

  it("模型不存在（NodeRuntime 内部 mustFind 抛 404）原样透传", async () => {
    const streamText = jest.fn(async () => {
      throw new NotFoundException("model m1 not found");
    });
    const { service } = makeService({ streamText });
    await expect(service.tryRun("p1", "pv1", baseReq)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("NodeRuntime 抛普通 Error（如 provider 超时）→ 502 BadGateway", async () => {
    const streamText = jest.fn(async () => {
      throw new Error("HTTP 500: upstream boom");
    });
    const { service } = makeService({ streamText });
    await expect(service.tryRun("p1", "pv1", baseReq)).rejects.toBeInstanceOf(BadGatewayException);
    await expect(service.tryRun("p1", "pv1", baseReq)).rejects.toThrow(/upstream boom/);
  });
});
