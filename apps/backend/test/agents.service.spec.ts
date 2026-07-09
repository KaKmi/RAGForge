import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { AgentsService } from "../src/modules/agents/agents.service";
import type { AgentsRepository } from "../src/modules/agents/agents.repository";
import type { KnowledgeBasesRepository } from "../src/modules/knowledge-bases/knowledge-bases.repository";
import type { ModelsService } from "../src/modules/models/models.service";
import type { PromptsService } from "../src/modules/prompts/prompts.service";
import type { AgentRow, AgentConfigVersionRow } from "../src/modules/agents/schema";

jest.setTimeout(30000);

const now = new Date("2026-07-09T00:00:00.000Z");
const nodeConfig = {
  freedom: "balance" as const,
  temperatureEnabled: true,
  temperature: 0.5,
  topPEnabled: false,
  topP: 0.9,
};
const nodeParams = {
  rewrite: nodeConfig,
  intent: nodeConfig,
  reply: nodeConfig,
  fallback: nodeConfig,
};
const validReq = {
  name: "售后助手",
  desc: "",
  kbIds: ["kb1"],
  genModelId: "m1",
  promptRewriteVerId: "pv1",
  promptIntentVerId: "pv2",
  promptReplyVerId: "pv3",
  promptFallbackVerId: "pv4",
  nodeParams,
  topK: 20,
  topN: 5,
  threshold: 0.65,
  multiRecall: true,
  fallbackHuman: true,
};

const agentRow: AgentRow = {
  id: "a1",
  name: "售后助手",
  desc: "",
  enabled: true,
  currentVersionId: "v1",
  createdAt: now,
  updatedAt: now,
  updatedBy: "u@x",
};
const v1Row: AgentConfigVersionRow = {
  id: "v1",
  agentId: "a1",
  version: 1,
  status: "published",
  genModelId: "m1",
  lightModelId: null,
  rerankModelId: null,
  promptRewriteVerId: "pv1",
  promptIntentVerId: "pv2",
  promptReplyVerId: "pv3",
  promptFallbackVerId: "pv4",
  nodeParams,
  topK: 20,
  topN: 5,
  threshold: 0.65,
  multiRecall: true,
  vecWeight: null,
  fallbackHuman: true,
  evalStatus: "exempt",
  evalRunAt: null,
  evalPassRate: null,
  evalSummary: null,
  note: null,
  createdBy: "u@x",
  createdAt: now,
  publishedBy: "u@x",
  publishedAt: now,
};
const draftV2Row: AgentConfigVersionRow = {
  ...v1Row,
  id: "v2",
  version: 2,
  status: "draft",
  evalStatus: "not_run",
  publishedBy: null,
  publishedAt: null,
};

function makeRepo(
  overrides: Partial<Record<keyof AgentsRepository, jest.Mock>> = {},
): AgentsRepository {
  return {
    findAgents: jest.fn(async () => []),
    findAgentById: jest.fn(async () => ({
      ...agentRow,
      currentVersionNumber: 1,
      currentVersionStatus: "published",
    })),
    findAgentByName: jest.fn(async () => undefined),
    findVersionById: jest.fn(async () => v1Row),
    findVersions: jest.fn(async () => [v1Row]),
    findVersionKbIds: jest.fn(async () => ["kb1"]),
    createAgentWithV1: jest.fn(async () => ({ agent: agentRow, version: v1Row })),
    insertDraftVersion: jest.fn(async () => draftV2Row),
    updateVersionEval: jest.fn(),
    updateAgentBase: jest.fn(async () => agentRow),
    promote: jest.fn(),
    ...overrides,
  } as unknown as AgentsRepository;
}

function makeKbRepo(overrides: Record<string, jest.Mock> = {}): KnowledgeBasesRepository {
  return {
    findByIds: jest.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, name: `库${id}`, embeddingModelId: "embed1" })),
    ),
    ...overrides,
  } as unknown as KnowledgeBasesRepository;
}

function makeModelsService(overrides: Record<string, jest.Mock> = {}): ModelsService {
  return {
    get: jest.fn(async (id: string) => {
      if (id === "m1") return { id, type: "llm", enabled: true };
      if (id === "mr1") return { id, type: "rerank", enabled: true };
      throw new NotFoundException(`model ${id} not found`);
    }),
    ...overrides,
  } as unknown as ModelsService;
}

function makePromptsService(overrides: Record<string, jest.Mock> = {}): PromptsService {
  const nodeById: Record<string, string> = {
    pv1: "rewrite",
    pv2: "intent",
    pv3: "reply",
    pv4: "fallback",
  };
  return {
    getVersionMeta: jest.fn(async (id: string) =>
      nodeById[id] ? { promptId: "p1", node: nodeById[id] } : null,
    ),
    ...overrides,
  } as unknown as PromptsService;
}

function makeService(deps: {
  repo?: AgentsRepository;
  kbRepo?: KnowledgeBasesRepository;
  models?: ModelsService;
  prompts?: PromptsService;
} = {}): AgentsService {
  return new AgentsService(
    deps.repo ?? makeRepo(),
    deps.kbRepo ?? makeKbRepo(),
    deps.models ?? makeModelsService(),
    deps.prompts ?? makePromptsService(),
  );
}

describe("AgentsService.create", () => {
  it("合法请求 → createAgentWithV1 被调用，返回 status=active + v1 evalStatus=exempt", async () => {
    const repo = makeRepo();
    const service = makeService({ repo });
    const res = await service.create(validReq, "u@x");
    expect(res.status).toBe("active");
    expect(res.currentVersion?.evalStatus).toBe("exempt");
    expect(res.currentVersion?.kbIds).toEqual(["kb1"]);
    expect(repo.createAgentWithV1).toHaveBeenCalledWith(
      expect.objectContaining({ name: "售后助手", currentVersionId: null, updatedBy: "u@x" }),
      expect.objectContaining({ version: 1, status: "published", evalStatus: "exempt" }),
      ["kb1"],
    );
  });

  it("同名 Agent 已存在 → 409", async () => {
    const repo = makeRepo({ findAgentByName: jest.fn(async () => agentRow) });
    const service = makeService({ repo });
    await expect(service.create(validReq, "u@x")).rejects.toBeInstanceOf(ConflictException);
  });

  it("kbIds 指向不同 embedding 模型 → 400（集合级判断，顺序无关）", async () => {
    const kbRepo = makeKbRepo({
      findByIds: jest.fn(async () => [
        { id: "kb1", name: "库A", embeddingModelId: "embed1" },
        { id: "kb2", name: "库B", embeddingModelId: "embed2" },
      ]),
    });
    const service = makeService({ kbRepo });
    await expect(
      service.create({ ...validReq, kbIds: ["kb1", "kb2"] }, "u@x"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("kbIds 有不存在的 → 404", async () => {
    const kbRepo = makeKbRepo({ findByIds: jest.fn(async () => []) });
    const service = makeService({ kbRepo });
    await expect(service.create(validReq, "u@x")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("genModelId 指向非 llm 类型模型 → 400", async () => {
    const models = makeModelsService({
      get: jest.fn(async () => ({ id: "m1", type: "embedding", enabled: true })),
    });
    const service = makeService({ models });
    await expect(service.create(validReq, "u@x")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("genModelId 指向已禁用模型 → 400", async () => {
    const models = makeModelsService({
      get: jest.fn(async () => ({ id: "m1", type: "llm", enabled: false })),
    });
    const service = makeService({ models });
    await expect(service.create(validReq, "u@x")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rerankModelId 指向非 rerank 类型模型 → 400", async () => {
    const service = makeService();
    await expect(
      service.create({ ...validReq, rerankModelId: "m1" }, "u@x"), // m1 是 llm
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("promptRewriteVerId 指向 node 不匹配的版本 → 400", async () => {
    const service = makeService();
    await expect(
      service.create({ ...validReq, promptRewriteVerId: "pv2" }, "u@x"), // pv2 是 intent 节点
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("promptRewriteVerId 指向不存在的版本 → 404", async () => {
    const service = makeService();
    await expect(
      service.create({ ...validReq, promptRewriteVerId: "nope" }, "u@x"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("重复 kbIds 去重后落库（不撞 agent_config_version_kbs 复合主键）", async () => {
    const repo = makeRepo();
    const service = makeService({ repo });
    await service.create({ ...validReq, kbIds: ["kb1", "kb1"] }, "u@x");
    expect(repo.createAgentWithV1).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      ["kb1"], // 去重后只剩一个
    );
  });
});

describe("AgentsService.updateBase", () => {
  it("PATCH 仅 name/desc/enabled 落库（updatedBy 来自 actor）", async () => {
    const repo = makeRepo();
    const service = makeService({ repo });
    const res = await service.updateBase("a1", { name: "新名字" }, "u@x");
    expect(repo.updateAgentBase).toHaveBeenCalledWith("a1", { name: "新名字", updatedBy: "u@x" });
    expect(res.id).toBe("a1");
  });

  it("Agent 不存在 → 404", async () => {
    const repo = makeRepo({ findAgentById: jest.fn(async () => undefined) });
    const service = makeService({ repo });
    await expect(service.updateBase("nope", { name: "x" }, "u@x")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("改名撞其他 Agent 的唯一名 → 409（改成自己现名不冲突）", async () => {
    const other = { ...agentRow, id: "a2", name: "占用名" };
    const repo = makeRepo({
      findAgentByName: jest.fn(async (name: string) => (name === "占用名" ? other : undefined)),
    });
    const service = makeService({ repo });
    await expect(service.updateBase("a1", { name: "占用名" }, "u@x")).rejects.toBeInstanceOf(
      ConflictException,
    );
    // 改成自己已有的名字（findAgentByName 返回自己）不应 409
    const repoSelf = makeRepo({
      findAgentByName: jest.fn(async () => ({ ...agentRow, id: "a1" })),
    });
    const serviceSelf = makeService({ repo: repoSelf });
    await expect(serviceSelf.updateBase("a1", { name: "售后助手" }, "u@x")).resolves.toBeTruthy();
  });
});

describe("AgentsService.createVersion", () => {
  it("新建草稿版本 → version=max+1，evalStatus=not_run，不动 agents 表", async () => {
    const repo = makeRepo();
    const service = makeService({ repo });
    const res = await service.createVersion("a1", { ...validReq, note: "调参" }, "u@x");
    expect(repo.insertDraftVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "a1",
        version: 2, // 已有 v1 → next=2
        status: "draft",
        evalStatus: "not_run",
        note: "调参",
        createdBy: "u@x",
      }),
      ["kb1"],
    );
    expect(res.evalStatus).toBe("not_run");
  });
});

describe("AgentsService — Eval stub 与发布/回滚门槛", () => {
  it("evalRun stub → evalStatus=passed, evalPassRate=null, evalSummary 带 stub 标记", async () => {
    const repo = makeRepo({
      findVersionById: jest.fn(async () => draftV2Row),
      updateVersionEval: jest.fn(async (_id, patch) => ({ ...draftV2Row, ...patch })),
    });
    const service = makeService({ repo });
    const res = await service.evalRun("a1", "v2");
    expect(res.evalStatus).toBe("passed");
    expect(res.evalPassRate).toBeNull();
    expect(repo.updateVersionEval).toHaveBeenCalledWith(
      "v2",
      expect.objectContaining({
        evalStatus: "passed",
        evalPassRate: null,
        evalSummary: expect.objectContaining({ stub: true }),
      }),
    );
  });

  it("evalRun 对非 draft 版本 → 409", async () => {
    const repo = makeRepo({ findVersionById: jest.fn(async () => v1Row) }); // published
    const service = makeService({ repo });
    await expect(service.evalRun("a1", "v1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("发布 evalStatus=not_run 的草稿 → 409（Eval 门槛，008 Invariant 2）", async () => {
    const repo = makeRepo({ findVersionById: jest.fn(async () => draftV2Row) });
    const service = makeService({ repo });
    await expect(service.publish("a1", "v2", "u@x")).rejects.toBeInstanceOf(ConflictException);
  });

  it("发布 evalStatus=passed 的草稿 → promote 被调用", async () => {
    const passed = { ...draftV2Row, evalStatus: "passed" };
    const repo = makeRepo({
      findVersionById: jest.fn(async () => passed),
      promote: jest.fn(async () => ({ ...passed, status: "published" })),
    });
    const service = makeService({ repo });
    const res = await service.publish("a1", "v2", "u@x");
    expect(repo.promote).toHaveBeenCalledWith("a1", "v2", "u@x");
    expect(res.status).toBe("published");
  });

  it("发布非 draft 版本 → 409", async () => {
    const repo = makeRepo({ findVersionById: jest.fn(async () => v1Row) }); // published
    const service = makeService({ repo });
    await expect(service.publish("a1", "v1", "u@x")).rejects.toBeInstanceOf(ConflictException);
  });

  it("版本不属于该 agent → 404", async () => {
    const repo = makeRepo({
      findVersionById: jest.fn(async () => ({ ...draftV2Row, agentId: "other" })),
    });
    const service = makeService({ repo });
    await expect(service.publish("a1", "v2", "u@x")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rollback 目标版本非 archived → 409", async () => {
    const repo = makeRepo({ findVersionById: jest.fn(async () => draftV2Row) }); // draft
    const service = makeService({ repo });
    await expect(service.rollback("a1", "v2", "u@x")).rejects.toBeInstanceOf(ConflictException);
  });

  it("rollback archived 版本 → promote 被调用，不重新校验 evalStatus", async () => {
    const archived = { ...draftV2Row, status: "archived", evalStatus: "not_run" };
    const repo = makeRepo({
      findVersionById: jest.fn(async () => archived),
      promote: jest.fn(async () => ({ ...archived, status: "published" })),
    });
    const service = makeService({ repo });
    await service.rollback("a1", "v2", "u@x");
    expect(repo.promote).toHaveBeenCalledWith("a1", "v2", "u@x");
  });
});

describe("AgentsService.list / get — 派生 status", () => {
  it("currentVersionId=null → draft；enabled=false → archived", async () => {
    const repo = makeRepo({
      findAgents: jest.fn(async () => [
        { ...agentRow, id: "a1", currentVersionId: null, currentVersionNumber: null, currentVersionStatus: null },
        { ...agentRow, id: "a2", enabled: false, currentVersionNumber: 1, currentVersionStatus: "published" },
      ]),
    });
    const service = makeService({ repo });
    const list = await service.list();
    expect(list[0].status).toBe("draft");
    expect(list[0].currentVersion).toBeNull();
    expect(list[1].status).toBe("archived");
  });

  it("get 不存在 → 404", async () => {
    const repo = makeRepo({ findAgentById: jest.fn(async () => undefined) });
    const service = makeService({ repo });
    await expect(service.get("nope")).rejects.toBeInstanceOf(NotFoundException);
  });
});
