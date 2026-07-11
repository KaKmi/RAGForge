import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ModelsService } from "../src/modules/models/models.service";
import { EncryptionService } from "../src/platform/security/encryption";
import type { ModelsRepository } from "../src/modules/models/models.repository";
import type { ModelProviderPort } from "../src/modules/models/ports/model-provider.port";
import type { ModelProviderRow, NewModelProvider } from "../src/modules/models/schema";

const enc = new EncryptionService(Buffer.alloc(32, 7).toString("base64"));

function makeRepo(rows: ModelProviderRow[] = []) {
  return {
    rows,
    find: jest.fn(async () => rows),
    findById: jest.fn(async (id: string) => rows.find((r) => r.id === id)),
    insert: jest.fn(async (row: NewModelProvider): Promise<ModelProviderRow> => {
      const r: ModelProviderRow = {
        id: "m1",
        type: row.type,
        protocol: row.protocol,
        name: row.name,
        baseUrl: row.baseUrl,
        apiKeyEnc: row.apiKeyEnc,
        deploymentId: row.deploymentId ?? null,
        params: row.params ?? {},
        enabled: row.enabled ?? true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      rows.push(r);
      return r;
    }),
    update: jest.fn(async (id: string, patch: Partial<NewModelProvider>) => {
      const r = rows.find((x) => x.id === id);
      if (r) Object.assign(r, patch, { updatedAt: new Date() });
      return r;
    }),
    delete: jest.fn(async (id: string) => {
      const i = rows.findIndex((x) => x.id === id);
      if (i >= 0) rows.splice(i, 1);
    }),
  };
}

const port: jest.Mocked<ModelProviderPort> = {
  testConnection: jest.fn(async () => ({ ok: true, latencyMs: 5, statusCode: 200 })),
};

const createReq = {
  type: "llm" as const,
  protocol: "openai_compat" as const,
  name: "deepseek-chat",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "sk-test12345678",
  params: { temperature: "0.3", max_tokens: "2048" },
  enabled: true,
};

describe("ModelsService", () => {
  beforeEach(() => port.testConnection.mockClear());

  it("create：repo 收到密文（非明文），响应只有掩码", async () => {
    const repo = makeRepo();
    const svc = new ModelsService(repo as unknown as ModelsRepository, enc, port);
    const created = await svc.create(createReq);
    const inserted = repo.insert.mock.calls[0][0];
    expect(inserted.apiKeyEnc.startsWith("v1:")).toBe(true);
    expect(inserted.apiKeyEnc).not.toContain("sk-test12345678");
    expect(inserted).not.toHaveProperty("apiKey");
    expect(created.apiKeyMasked).toBe("sk-****5678");
    expect(created).not.toHaveProperty("apiKey");
    expect(created).not.toHaveProperty("apiKeyEnc");
  });

  it("list：每行解密→掩码", async () => {
    const repo = makeRepo();
    const svc = new ModelsService(repo as unknown as ModelsRepository, enc, port);
    await svc.create(createReq);
    const [m] = await svc.list();
    expect(m.apiKeyMasked).toBe("sk-****5678");
  });

  it("update：带 apiKey 重加密；不带则 key 不变", async () => {
    const repo = makeRepo();
    const svc = new ModelsService(repo as unknown as ModelsRepository, enc, port);
    const created = await svc.create(createReq);
    const encBefore = repo.rows[0].apiKeyEnc;
    await svc.update(created.id, { enabled: false });
    expect(repo.rows[0].apiKeyEnc).toBe(encBefore);
    expect(repo.rows[0].enabled).toBe(false);
    await svc.update(created.id, { apiKey: "sk-newkey87654321" });
    expect(repo.rows[0].apiKeyEnc).not.toBe(encBefore);
    expect(enc.decrypt(repo.rows[0].apiKeyEnc)).toBe("sk-newkey87654321");
  });

  it("testById：解密后明文传给 port；不存在 → 404", async () => {
    const repo = makeRepo();
    const svc = new ModelsService(repo as unknown as ModelsRepository, enc, port);
    const created = await svc.create(createReq);
    const r = await svc.testById(created.id);
    expect(r).toMatchObject({ ok: true, latencyMs: 5, statusCode: 200 });
    expect(port.testConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "sk-test12345678",
        type: "llm",
        protocol: "openai_compat",
        params: { temperature: "0.3", max_tokens: "2048" },
      }),
    );
    await expect(svc.testById("nope")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("update 单改 protocol 导致非法组合 → 400（合并存量行校验）", async () => {
    const repo = makeRepo();
    const svc = new ModelsService(repo as unknown as ModelsRepository, enc, port);
    const created = await svc.create(createReq); // llm + openai_compat
    await expect(svc.update(created.id, { protocol: "dashscope" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // 合法换协议通过
    const updated = await svc.update(created.id, { protocol: "anthropic" });
    expect(updated.protocol).toBe("anthropic");
  });

  it("testById 带 override：用抽屉配置 + 存量 key；非法 override 组合 → 400", async () => {
    const repo = makeRepo();
    const svc = new ModelsService(repo as unknown as ModelsRepository, enc, port);
    const created = await svc.create(createReq);
    await svc.testById(created.id, { baseUrl: "http://new.internal:9090", protocol: "anthropic" });
    expect(port.testConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://new.internal:9090",
        protocol: "anthropic",
        apiKey: "sk-test12345678", // 存量 key，不来自 override
      }),
    );
    await expect(
      svc.testById(created.id, { protocol: "dashscope" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("remove：不存在 → 404；存在 → 删除", async () => {
    const repo = makeRepo();
    const svc = new ModelsService(repo as unknown as ModelsRepository, enc, port);
    await expect(svc.remove("nope")).rejects.toBeInstanceOf(NotFoundException);
    const created = await svc.create(createReq);
    await svc.remove(created.id);
    expect(repo.rows).toHaveLength(0);
  });

  // 回归：knowledge_bases.embedding_model_id 有 FK RESTRICT（007 Design），delete() 违反时
  // drizzle-orm 把真实 pg 错误包在 DrizzleQueryError.cause 里（非顶层 e.code）——
  // 用真实 drizzle 错误形状（cause.code='23503'）而非裸 {code} 对象，防止 mock 掩盖下钻 .cause 的实现细节。
  it("remove：模型仍被知识库引用（FK RESTRICT 违反）→ 转为可读 409，不裸奔原始 pg 错误", async () => {
    const repo = makeRepo();
    const svc = new ModelsService(repo as unknown as ModelsRepository, enc, port);
    const created = await svc.create(createReq);

    const pgError = Object.assign(new Error("violates foreign key constraint"), {
      code: "23503",
    });
    const drizzleQueryError = Object.assign(new Error("Failed query: delete from ..."), {
      cause: pgError,
    });
    repo.delete.mockRejectedValueOnce(drizzleQueryError);

    await expect(svc.remove(created.id)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("仍被知识库或 Agent 配置引用"),
    });
  });
});

describe("ModelsService.chat", () => {
  it("非 llm 类型 → 400，不调用 port", async () => {
    const repo = makeRepo();
    const chatPort = {
      testConnection: jest.fn(),
      embed: jest.fn(),
      rerank: jest.fn(),
      chat: jest.fn(),
      chatStream: jest.fn(),
    } as unknown as jest.Mocked<ModelProviderPort>;
    const svc = new ModelsService(repo as unknown as ModelsRepository, enc, chatPort);
    const created = await svc.create({
      type: "embedding",
      protocol: "self_hosted",
      name: "embed-1",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-embed12345",
      params: {},
      enabled: true,
    });
    await expect(svc.chat(created.id, [{ role: "user", content: "q" }])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(chatPort.chat).not.toHaveBeenCalled();
  });

  it("llm 类型：查行解密 key 后转发 port.chat()，返回值透传", async () => {
    const repo = makeRepo();
    const chatPort = {
      testConnection: jest.fn(),
      embed: jest.fn(),
      rerank: jest.fn(),
      chat: jest.fn(async () => ({ content: "回答内容" })),
      chatStream: jest.fn(),
    } as unknown as jest.Mocked<ModelProviderPort>;
    const svc = new ModelsService(repo as unknown as ModelsRepository, enc, chatPort);
    const created = await svc.create(createReq);
    const messages = [{ role: "system" as const, content: "s" }, { role: "user" as const, content: "u" }];
    const res = await svc.chat(created.id, messages, { temperature: 0.5 });
    expect(res).toEqual({ content: "回答内容" });
    expect(chatPort.chat).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-test12345678", protocol: "openai_compat" }),
      messages,
      { temperature: 0.5 },
    );
  });
});

describe("ModelsService.chatStream", () => {
  it("非 llm 类型 → 400，不调用 port", async () => {
    const repo = makeRepo();
    const chatPort = {
      testConnection: jest.fn(),
      embed: jest.fn(),
      rerank: jest.fn(),
      chat: jest.fn(),
      chatStream: jest.fn(),
    } as unknown as jest.Mocked<ModelProviderPort>;
    const svc = new ModelsService(repo as unknown as ModelsRepository, enc, chatPort);
    const created = await svc.create({
      type: "rerank",
      protocol: "cohere",
      name: "rerank-1",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-rerank12345",
      params: {},
      enabled: true,
    });
    await expect(
      svc.chatStream(created.id, [{ role: "user", content: "q" }]),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(chatPort.chatStream).not.toHaveBeenCalled();
  });

  it("llm 类型：转发 port.chatStream()，AsyncIterable 逐块透传", async () => {
    const repo = makeRepo();
    async function* gen() {
      yield { delta: "你" };
      yield { delta: "好" };
      yield { done: true };
    }
    const chatPort = {
      testConnection: jest.fn(),
      embed: jest.fn(),
      rerank: jest.fn(),
      chat: jest.fn(),
      chatStream: jest.fn(() => gen()),
    } as unknown as jest.Mocked<ModelProviderPort>;
    const svc = new ModelsService(repo as unknown as ModelsRepository, enc, chatPort);
    const created = await svc.create(createReq);
    const stream = await svc.chatStream(created.id, [{ role: "user", content: "u" }]);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks).toEqual([{ delta: "你" }, { delta: "好" }, { done: true }]);
    expect(chatPort.chatStream).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-test12345678" }),
      [{ role: "user", content: "u" }],
      undefined,
    );
  });
});

describe("ModelsService.rerankTexts", () => {
  it("查行、解密 key、调用 provider.rerank，返回 results", async () => {
    const repo = makeRepo();
    // 局部 port（不复用文件顶部共享 port 常量）：只为本用例声明 rerank，避免打乱其它用例
    const rerankPort = {
      testConnection: jest.fn(),
      embed: jest.fn(),
      rerank: jest.fn(async () => ({ results: [{ index: 0, score: 0.9 }] })),
    } as unknown as jest.Mocked<ModelProviderPort>;
    const svc = new ModelsService(repo as unknown as ModelsRepository, enc, rerankPort);
    const created = await svc.create({
      type: "rerank",
      protocol: "cohere",
      name: "rerank-v3",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-rerank12345",
      params: {},
      enabled: true,
    });
    const results = await svc.rerankTexts(created.id, "问题", ["a", "b"], 5);
    expect(results).toEqual([{ index: 0, score: 0.9 }]);
    expect(rerankPort.rerank).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-rerank12345", protocol: "cohere" }),
      "问题",
      ["a", "b"],
      5,
    );
  });
});
