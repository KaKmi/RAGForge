import { ConflictException, NotFoundException } from "@nestjs/common";
import type { PromptRow, PromptVersionRow } from "../src/modules/prompts/schema";
import type { PromptListRow } from "../src/modules/prompts/prompts.repository";
import { PromptsService } from "../src/modules/prompts/prompts.service";
import type { PromptsRepository } from "../src/modules/prompts/prompts.repository";

jest.setTimeout(30000);

const now = new Date("2026-07-01T00:00:00.000Z");
const promptRow: PromptRow = {
  id: "p1",
  name: "问题改写",
  node: "rewrite",
  currentVersionId: null,
  updatedBy: "u@x",
  createdAt: now,
  updatedAt: now,
};
// findPromptById/findPrompts 返回带聚合的行（方案 A：后端 join currentVersionNumber + versionCount）
const promptListRow: PromptListRow = {
  ...promptRow,
  currentVersionNumber: null,
  versionCount: 1,
};
const versionRow: PromptVersionRow = {
  id: "pv1",
  promptId: "p1",
  version: 1,
  body: "你好 {query}",
  variables: ["query"],
  note: null,
  author: "u@x",
  status: "draft",
  createdAt: now,
};

function makeRepo(
  overrides: Partial<Record<keyof PromptsRepository, jest.Mock>> = {},
): PromptsRepository {
  return {
    findPrompts: jest.fn(),
    findPromptById: jest.fn(),
    insertPrompt: jest.fn(),
    findVersions: jest.fn(),
    findVersionById: jest.fn(),
    insertVersion: jest.fn(),
    publishVersion: jest.fn(),
    deletePrompt: jest.fn(),
    ...overrides,
  } as unknown as PromptsRepository;
}

describe("PromptsService", () => {
  it("createPrompt → insertPrompt(updatedBy=actor, currentVersionId:null) + insertVersion(variables=extractVars(body), author=actor, status:draft, version:1) + findPromptById 取聚合行", async () => {
    const repo = makeRepo({
      insertPrompt: jest.fn(async () => promptRow),
      insertVersion: jest.fn(async () => versionRow),
      findPromptById: jest.fn(async () => promptListRow),
    });
    const service = new PromptsService(repo);
    const res = await service.createPrompt(
      { name: "n", node: "rewrite", body: "你好 {query}", note: "x" },
      "actor@x",
    );
    expect(repo.insertPrompt).toHaveBeenCalledWith({
      name: "n",
      node: "rewrite",
      currentVersionId: null,
      updatedBy: "actor@x",
    });
    expect(repo.insertVersion).toHaveBeenCalledWith({
      promptId: "p1",
      version: 1,
      body: "你好 {query}",
      variables: ["query"],
      note: "x",
      author: "actor@x",
      status: "draft",
    });
    expect(repo.findPromptById).toHaveBeenCalledWith("p1");
    expect(res.currentVersionId).toBeNull();
    expect(res.currentVersionNumber).toBeNull();
    expect(res.versionCount).toBe(1);
    expect(res.updatedBy).toBe("u@x");
  });

  it("createVersion → next = max(versions) + 1（[v1,v3] → 4）", async () => {
    const repo = makeRepo({
      findPromptById: jest.fn(async () => promptListRow),
      findVersions: jest.fn(async () => [
        { ...versionRow, version: 1 },
        { ...versionRow, version: 3 },
      ]),
      insertVersion: jest.fn(async () => ({ ...versionRow, version: 4 })),
    });
    const service = new PromptsService(repo);
    const res = await service.createVersion("p1", { body: "新 {q}" }, "actor@x");
    expect(repo.insertVersion.mock.calls[0][0].version).toBe(4);
    expect(repo.insertVersion.mock.calls[0][0].variables).toEqual(["q"]);
    expect(res.version).toBe(4);
  });

  it("createVersion 撞 unique → retry 一次成功（insertVersion 调 2 次）", async () => {
    const repo = makeRepo({
      findPromptById: jest.fn(async () => promptListRow),
      findVersions: jest.fn(async () => [{ ...versionRow, version: 1 }]),
      insertVersion: jest
        .fn()
        .mockRejectedValueOnce({ code: "23505" })
        .mockResolvedValueOnce({ ...versionRow, version: 2 }),
    });
    const service = new PromptsService(repo);
    const res = await service.createVersion("p1", { body: "b" }, "actor@x");
    expect(repo.insertVersion).toHaveBeenCalledTimes(2);
    expect(res.version).toBe(2);
  });

  it("createVersion retry 仍冲突 → ConflictException（insertVersion 调 2 次）", async () => {
    const repo = makeRepo({
      findPromptById: jest.fn(async () => promptListRow),
      findVersions: jest.fn(async () => [{ ...versionRow, version: 1 }]),
      insertVersion: jest.fn().mockRejectedValue({ code: "23505" }),
    });
    const service = new PromptsService(repo);
    await expect(service.createVersion("p1", { body: "b" }, "actor@x")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(repo.insertVersion).toHaveBeenCalledTimes(2);
  });

  it("createVersion 非 unique 错误 → 直接抛（不 retry，insertVersion 调 1 次）", async () => {
    const insertVersion = jest.fn().mockRejectedValue(new Error("boom"));
    const repo = makeRepo({
      findPromptById: jest.fn(async () => promptListRow),
      findVersions: jest.fn(async () => []),
      insertVersion,
    });
    const service = new PromptsService(repo);
    await expect(service.createVersion("p1", { body: "b" }, "actor@x")).rejects.toThrow("boom");
    expect(insertVersion).toHaveBeenCalledTimes(1);
  });

  it("promote draft→prod → repo.publishVersion 收到 (promptId, versionId, actorEmail)", async () => {
    const repo = makeRepo({
      findVersionById: jest.fn(async () => ({ ...versionRow, status: "draft", promptId: "p1" })),
      publishVersion: jest.fn(async () => ({ ...versionRow, status: "prod" })),
    });
    const service = new PromptsService(repo);
    const res = await service.promote("p1", "pv1", "actor@x");
    expect(repo.publishVersion).toHaveBeenCalledWith("p1", "pv1", "actor@x");
    expect(res.status).toBe("prod");
  });

  it("promote 已 prod → ConflictException（D15）", async () => {
    const repo = makeRepo({
      findVersionById: jest.fn(async () => ({ ...versionRow, status: "prod", promptId: "p1" })),
    });
    const service = new PromptsService(repo);
    await expect(service.promote("p1", "pv1", "actor@x")).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("promote 版本不属于该 prompt → NotFoundException", async () => {
    const repo = makeRepo({
      findVersionById: jest.fn(async () => ({
        ...versionRow,
        status: "draft",
        promptId: "other",
      })),
    });
    const service = new PromptsService(repo);
    await expect(service.promote("p1", "pv1", "actor@x")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("promote 版本不存在 → NotFoundException", async () => {
    const repo = makeRepo({ findVersionById: jest.fn(async () => undefined) });
    const service = new PromptsService(repo);
    await expect(service.promote("p1", "pv1", "actor@x")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("list 透传 query + 返回 { items, total, page, pageSize } + toPrompt 映射（D16 + 方案 A + 分页）", async () => {
    const repo = makeRepo({
      findPrompts: jest.fn(async () => ({
        items: [
          {
            ...promptListRow,
            currentVersionId: "pv9",
            currentVersionNumber: 7,
            versionCount: 3,
            updatedAt: new Date("2026-07-01T00:00:00.000Z"),
            updatedBy: "u@x",
          },
        ],
        total: 1,
      })),
    });
    const service = new PromptsService(repo);
    const res = await service.list({ page: 1, pageSize: 10 });
    expect(repo.findPrompts).toHaveBeenCalledWith({ page: 1, pageSize: 10 });
    expect(res.total).toBe(1);
    expect(res.page).toBe(1);
    expect(res.pageSize).toBe(10);
    expect(res.items[0].updatedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(res.items[0].updatedBy).toBe("u@x");
    expect(res.items[0].currentVersionId).toBe("pv9");
    expect(res.items[0].currentVersionNumber).toBe(7);
    expect(res.items[0].versionCount).toBe(3);
  });

  it("list 透传 search/node/status 给 repo（条件查询）", async () => {
    const findPrompts = jest.fn(async () => ({ items: [], total: 0 }));
    const repo = makeRepo({ findPrompts });
    const service = new PromptsService(repo);
    await service.list({ page: 2, pageSize: 20, search: "改写", node: "rewrite", status: "draft" });
    expect(findPrompts).toHaveBeenCalledWith({
      page: 2,
      pageSize: 20,
      search: "改写",
      node: "rewrite",
      status: "draft",
    });
  });

  it("toVersion 把 createdAt Date → ISO 映射（D16）", async () => {
    const repo = makeRepo({
      findPromptById: jest.fn(async () => promptListRow),
      findVersions: jest.fn(async () => [
        { ...versionRow, createdAt: new Date("2026-07-01T00:00:00.000Z") },
      ]),
    });
    const service = new PromptsService(repo);
    const list = await service.listVersions("p1");
    expect(list[0].createdAt).toBe("2026-07-01T00:00:00.000Z");
    expect(list[0].author).toBe("u@x");
  });

  it("createVersion 用 extractVars(body) 填 variables，author 来自 actorEmail（D5/D6：不读请求体）", async () => {
    const repo = makeRepo({
      findPromptById: jest.fn(async () => promptListRow),
      findVersions: jest.fn(async () => []),
      insertVersion: jest.fn(async () => versionRow),
    });
    const service = new PromptsService(repo);
    await service.createVersion("p1", { body: "你好 {query} {name}" }, "actor@x");
    expect(repo.insertVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: ["query", "name"],
        author: "actor@x",
        status: "draft",
      }),
    );
  });

  it("delete 草稿（currentVersionId:null）→ repo.deletePrompt(id)", async () => {
    const deletePrompt = jest.fn(async () => undefined);
    const repo = makeRepo({
      findPromptById: jest.fn(async () => promptListRow), // currentVersionId:null
      deletePrompt,
    });
    const service = new PromptsService(repo);
    await service.delete("p1");
    expect(deletePrompt).toHaveBeenCalledWith("p1");
  });

  it("delete 已启用（currentVersionId !== null）→ ConflictException 且不调 deletePrompt", async () => {
    const repo = makeRepo({
      findPromptById: jest.fn(async () => ({ ...promptListRow, currentVersionId: "pv1" })),
      deletePrompt: jest.fn(),
    });
    const service = new PromptsService(repo);
    await expect(service.delete("p1")).rejects.toBeInstanceOf(ConflictException);
    expect(repo.deletePrompt).not.toHaveBeenCalled();
  });

  it("delete 不存在 → NotFoundException 且不调 deletePrompt", async () => {
    const repo = makeRepo({
      findPromptById: jest.fn(async () => undefined),
      deletePrompt: jest.fn(),
    });
    const service = new PromptsService(repo);
    await expect(service.delete("p1")).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.deletePrompt).not.toHaveBeenCalled();
  });
});
