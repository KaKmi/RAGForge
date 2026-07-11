import {
  BadGatewayException,
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { ModelProvider } from "@codecrush/contracts";
import { PromptsService } from "../src/modules/prompts/prompts.service";
import type { PromptsRepository, PromptListRow } from "../src/modules/prompts/prompts.repository";
import type { ModelsService } from "../src/modules/models/models.service";
import type { PromptVersionRow } from "../src/modules/prompts/schema";

// 012 Story 7 §6：try-run 分支矩阵（drill 收口）——版本归属 / 编译错误 422 /
// refApplicationId 门控 / rewrite·intent pending / 字段要求 / 协议矩阵 / provider 错误映射

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
const llmModel: ModelProvider = {
  id: "m1",
  type: "llm",
  protocol: "openai_compat",
  name: "deepseek-v3",
  baseUrl: "https://api.example.com/v1",
  apiKeyMasked: "sk-****",
  params: {},
  enabled: true,
};

const baseReq = {
  modelId: "m1",
  testVars: { query: "怎么退货" },
};

function makeService(over: {
  prompt?: Partial<PromptListRow>;
  version?: Partial<PromptVersionRow> | null;
  model?: Partial<ModelProvider>;
  chatText?: jest.Mock;
  getModel?: jest.Mock;
}) {
  const repo = {
    findPromptById: jest.fn(async () => ({ ...replyPrompt, ...over.prompt })),
    findVersionById: jest.fn(async () =>
      over.version === null ? undefined : { ...version, ...over.version },
    ),
  } as unknown as PromptsRepository;
  const chatText = over.chatText ?? jest.fn(async () => ({ text: "模型输出" }));
  const models = {
    get: over.getModel ?? jest.fn(async () => ({ ...llmModel, ...over.model })),
    chatText,
  } as unknown as ModelsService;
  return { service: new PromptsService(repo, models), chatText, models };
}

describe("PromptsService.tryRun · 前置校验", () => {
  it("版本不属于该 Prompt → 404，不触达模型", async () => {
    const { service, chatText } = makeService({ version: { promptId: "other" } });
    await expect(service.tryRun("p1", "pv1", baseReq)).rejects.toBeInstanceOf(NotFoundException);
    expect(chatText).not.toHaveBeenCalled();
  });

  it("存量 compile_status=has_errors → 422，不调用 provider", async () => {
    const { service, chatText } = makeService({ version: { compileStatus: "has_errors" } });
    await expect(service.tryRun("p1", "pv1", baseReq)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(chatText).not.toHaveBeenCalled();
  });

  it("refApplicationId 非空 → unavailable/application_context_not_available（009 依赖门控）", async () => {
    const { service, chatText } = makeService({});
    const res = await service.tryRun("p1", "pv1", { ...baseReq, refApplicationId: "app-1" });
    expect(res).toEqual({ mode: "unavailable", reason: "application_context_not_available" });
    expect(chatText).not.toHaveBeenCalled();
  });

  it.each(["rewrite", "intent"] as const)(
    "%s 节点 → unavailable/pending_node_runtime（不伪造结构化结果）",
    async (node) => {
      const { service, chatText } = makeService({ prompt: { node } });
      const res = await service.tryRun("p1", "pv1", baseReq);
      expect(res).toEqual({ mode: "unavailable", reason: "pending_node_runtime" });
      expect(chatText).not.toHaveBeenCalled();
    },
  );

  it("reply 缺 query → 400；fallback 缺 reason → 400", async () => {
    const { service } = makeService({});
    await expect(
      service.tryRun("p1", "pv1", { modelId: "m1", testVars: { query: "  " } }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const fb = makeService({ prompt: { node: "fallback" } });
    await expect(
      fb.service.tryRun("p1", "pv1", { modelId: "m1", testVars: { query: "q" } }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("模型非 llm → 400；协议不在矩阵 → unavailable/unsupported_protocol", async () => {
    const notLlm = makeService({ model: { type: "embedding" } });
    await expect(notLlm.service.tryRun("p1", "pv1", baseReq)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    const cohere = makeService({ model: { protocol: "cohere" } });
    const res = await cohere.service.tryRun("p1", "pv1", baseReq);
    expect(res).toEqual({ mode: "unavailable", reason: "unsupported_protocol" });
    expect(cohere.chatText).not.toHaveBeenCalled();
  });
});

describe("PromptsService.tryRun · 真实调用路径", () => {
  it("reply 成功：渲染不可变 body 为 system（缺省字段按空串），query 作 user，temperature 透传", async () => {
    const { service, chatText } = makeService({});
    const res = await service.tryRun("p1", "pv1", {
      modelId: "m1",
      temperature: 1.2,
      testVars: { query: "怎么退货", retrievalContext: "第二条 七天无理由" },
    });
    expect(res).toEqual({ mode: "text", text: "模型输出" });
    expect(chatText).toHaveBeenCalledWith(
      "m1",
      {
        system: "依据 第二条 七天无理由 回答 怎么退货，历史：",
        user: "怎么退货",
      },
      { temperature: 1.2 },
    );
  });

  it("fallback 成功：reason 参与渲染", async () => {
    const { service, chatText } = makeService({
      prompt: { node: "fallback" },
      version: { body: "因 {reason} 无法回答 {query}" },
    });
    const res = await service.tryRun("p1", "pv1", {
      modelId: "m1",
      testVars: { query: "q", reason: "未命中知识" },
    });
    expect(res.mode).toBe("text");
    expect(chatText.mock.calls[0][1].system).toBe("因 未命中知识 无法回答 q");
  });

  it("provider 失败 → 502 BadGateway（错误响应，不是 unavailable）", async () => {
    const { service } = makeService({
      chatText: jest.fn(async () => {
        throw new Error("HTTP 500: upstream boom");
      }),
    });
    await expect(service.tryRun("p1", "pv1", baseReq)).rejects.toBeInstanceOf(BadGatewayException);
    await expect(service.tryRun("p1", "pv1", baseReq)).rejects.toThrow(/upstream boom/);
  });

  it("模型不存在（ModelsService.get 抛 404）原样透传", async () => {
    const { service } = makeService({
      getModel: jest.fn(async () => {
        throw new NotFoundException("model m1 not found");
      }),
    });
    await expect(service.tryRun("p1", "pv1", baseReq)).rejects.toBeInstanceOf(NotFoundException);
  });
});
