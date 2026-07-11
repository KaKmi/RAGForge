import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import type { PromptRow, PromptVersionRow } from "../src/modules/prompts/schema";
import type { PromptListRow } from "../src/modules/prompts/prompts.repository";
import { PromptsService } from "../src/modules/prompts/prompts.service";
import type { PromptsRepository } from "../src/modules/prompts/prompts.repository";

jest.setTimeout(30000);

const now = new Date("2026-07-01T00:00:00.000Z");
const promptRow: PromptRow = {
  id: "p1",
  name: "回复生成-通用",
  node: "reply",
  currentVersionId: null,
  updatedBy: "u@x",
  createdAt: now,
  updatedAt: now,
};
const promptListRow: PromptListRow = {
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
const versionRow: PromptVersionRow = {
  id: "pv1",
  promptId: "p1",
  version: 1,
  body: "你好 {query}",
  variables: ["query"],
  contractVersion: 1,
  compileStatus: "ok",
  compileErrors: [],
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
    findPromptById: jest.fn(async () => promptListRow),
    createPromptWithV1: jest.fn(),
    findVersions: jest.fn(async () => []),
    findVersionById: jest.fn(),
    insertVersion: jest.fn(),
    touchPrompt: jest.fn(async () => undefined),
    findTagsByPromptId: jest.fn(async () => []),
    findTagsByVersionIds: jest.fn(async () => []),
    findTagsWithVersion: jest.fn(async () => []),
    upsertTag: jest.fn(async () => undefined),
    deleteTag: jest.fn(),
    findNodeVersionCandidates: jest.fn(async () => []),
    deletePrompt: jest.fn(),
    ...overrides,
  } as unknown as PromptsRepository;
}

describe("PromptsService · createPrompt（事务空 v1）", () => {
  it("createPromptWithV1 收到空 body v1 种子：compileStatus=ok、contractVersion=1、兼容 status=draft", async () => {
    const createPromptWithV1 = jest.fn(async () => ({
      prompt: promptRow,
      version: { ...versionRow, body: "" },
    }));
    const repo = makeRepo({
      createPromptWithV1,
      findVersions: jest.fn(async () => [{ ...versionRow, body: "" }]),
    });
    const service = new PromptsService(repo);
    const res = await service.createPrompt({ name: "n", node: "reply" }, "actor@x");
    expect(createPromptWithV1).toHaveBeenCalledWith(
      { name: "n", node: "reply", updatedBy: "actor@x" },
      expect.objectContaining({
        version: 1,
        body: "",
        variables: [],
        contractVersion: 1,
        compileStatus: "ok",
        compileErrors: [],
        author: "actor@x",
        status: "draft",
      }),
    );
    expect(res.versions).toHaveLength(1);
    expect(res.latestVersion).toBe(1);
  });

  it("撞名唯一冲突（顶层 code 23505）→ ConflictException", async () => {
    const repo = makeRepo({
      createPromptWithV1: jest.fn().mockRejectedValue({ code: "23505" }),
    });
    const service = new PromptsService(repo);
    await expect(service.createPrompt({ name: "n", node: "reply" }, "a@x")).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe("PromptsService · createVersion（不可变保存 + 服务端编译）", () => {
  it("编译结果持久化：未知变量 body → compileStatus=has_errors + issues 非空，仍允许保存", async () => {
    const insertVersion = jest.fn(async (row) => ({ ...versionRow, ...row, id: "pv2" }));
    const repo = makeRepo({
      findVersions: jest.fn(async () => [versionRow]),
      insertVersion,
    });
    const service = new PromptsService(repo);
    const res = await service.createVersion("p1", { body: "{oops_unknown}" }, "actor@x");
    const inserted = insertVersion.mock.calls[0][0];
    expect(inserted.compileStatus).toBe("has_errors");
    expect(inserted.compileErrors[0].code).toBe("UNKNOWN_VARIABLE");
    expect(inserted.status).toBe("draft"); // 兼容窗口显式写
    expect(res.compileStatus).toBe("has_errors");
  });

  it("空 body 允许保存（compileStatus=ok），版本号 = 最新 + 1", async () => {
    const insertVersion = jest.fn(async (row) => ({ ...versionRow, ...row, id: "pv4" }));
    const repo = makeRepo({
      findVersions: jest.fn(async () => [
        { ...versionRow, version: 3 },
        { ...versionRow, version: 1 },
      ]),
      insertVersion,
    });
    const service = new PromptsService(repo);
    const res = await service.createVersion("p1", { body: "" }, "actor@x");
    expect(insertVersion.mock.calls[0][0].version).toBe(4);
    expect(insertVersion.mock.calls[0][0].compileStatus).toBe("ok");
    expect(res.version).toBe(4);
  });

  it("保存后刷新 prompt 更新人/时间（touchPrompt）", async () => {
    const touchPrompt = jest.fn(async () => undefined);
    const repo = makeRepo({
      findVersions: jest.fn(async () => [versionRow]),
      insertVersion: jest.fn(async (row) => ({ ...versionRow, ...row })),
      touchPrompt,
    });
    const service = new PromptsService(repo);
    await service.createVersion("p1", { body: "b {query}" }, "actor@x");
    expect(touchPrompt).toHaveBeenCalledWith("p1", "actor@x");
  });

  it("sourceVersionId 沿用来源 contractVersion（创建副本语义）", async () => {
    const insertVersion = jest.fn(async (row) => ({ ...versionRow, ...row }));
    const repo = makeRepo({
      findVersionById: jest.fn(async () => ({ ...versionRow, contractVersion: 7 })),
      findVersions: jest.fn(async () => [versionRow]),
      insertVersion,
    });
    const service = new PromptsService(repo);
    await service.createVersion("p1", { body: "b", sourceVersionId: "pv1" }, "actor@x");
    expect(insertVersion.mock.calls[0][0].contractVersion).toBe(7);
  });

  it("sourceVersionId 跨 Prompt → BadRequestException", async () => {
    const repo = makeRepo({
      findVersionById: jest.fn(async () => ({ ...versionRow, promptId: "other" })),
    });
    const service = new PromptsService(repo);
    await expect(
      service.createVersion("p1", { body: "b", sourceVersionId: "pvX" }, "a@x"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("撞 unique（wrapped cause.code=23505）→ retry 一次成功", async () => {
    const wrapped = Object.assign(new Error("duplicate key"), { cause: { code: "23505" } });
    const repo = makeRepo({
      findVersions: jest.fn(async () => [versionRow]),
      insertVersion: jest
        .fn()
        .mockRejectedValueOnce(wrapped)
        .mockResolvedValueOnce({ ...versionRow, version: 2 }),
    });
    const service = new PromptsService(repo);
    const res = await service.createVersion("p1", { body: "b" }, "actor@x");
    expect(repo.insertVersion).toHaveBeenCalledTimes(2);
    expect(res.version).toBe(2);
  });

  it("retry 仍冲突 → ConflictException；非 unique 错误 → 原样抛不 retry", async () => {
    const repo = makeRepo({
      findVersions: jest.fn(async () => [versionRow]),
      insertVersion: jest.fn().mockRejectedValue({ code: "23505" }),
    });
    const service = new PromptsService(repo);
    await expect(service.createVersion("p1", { body: "b" }, "a@x")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(repo.insertVersion).toHaveBeenCalledTimes(2);

    const repo2 = makeRepo({
      findVersions: jest.fn(async () => []),
      insertVersion: jest.fn().mockRejectedValue(new Error("boom")),
    });
    const service2 = new PromptsService(repo2);
    await expect(service2.createVersion("p1", { body: "b" }, "a@x")).rejects.toThrow("boom");
    expect(repo2.insertVersion).toHaveBeenCalledTimes(1);
  });
});

describe("PromptsService · 详情与版本列表", () => {
  it("getDetail 返回摘要 + 降序版本 + 各版本标签", async () => {
    const repo = makeRepo({
      findVersions: jest.fn(async () => [
        { ...versionRow, id: "pv2", version: 2 },
        { ...versionRow, id: "pv1", version: 1 },
      ]),
      findTagsByPromptId: jest.fn(async () => [
        { promptVersionId: "pv2", name: "production" },
        { promptVersionId: "pv1", name: "baseline" },
      ]),
      findPromptById: jest.fn(async () => ({
        ...promptListRow,
        latestVersionId: "pv2",
        latestVersion: 2,
        versionCount: 2,
      })),
    });
    const service = new PromptsService(repo);
    const res = await service.getDetail("p1");
    expect(res.latestVersion).toBe(2);
    expect(res.tags).toEqual(["production"]);
    expect(res.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(res.versions[0].tags).toEqual(["production"]);
    expect(res.versions[1].tags).toEqual(["baseline"]);
    expect(res.versions[0].createdAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("getDetail 不存在 → NotFoundException", async () => {
    const repo = makeRepo({ findPromptById: jest.fn(async () => undefined) });
    const service = new PromptsService(repo);
    await expect(service.getDetail("nope")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("兼容窗口：compile_status 为空的旧行按需用共享编译器重算", async () => {
    const repo = makeRepo({
      findVersions: jest.fn(async () => [
        { ...versionRow, compileStatus: null, compileErrors: null, body: "{nope_x}" },
      ]),
    });
    const service = new PromptsService(repo);
    const list = await service.listVersions("p1");
    expect(list[0].compileStatus).toBe("has_errors");
    expect(list[0].compileErrors[0].code).toBe("UNKNOWN_VARIABLE");
  });
});

describe("PromptsService · list（最新版本摘要 + 批量标签）", () => {
  it("items 映射 latestVersion/versionCount/tags/variables，批量取标签防 N+1", async () => {
    const findTagsByVersionIds = jest.fn(async () => [
      { promptVersionId: "pv9", name: "production" },
    ]);
    const repo = makeRepo({
      findPrompts: jest.fn(async () => ({
        items: [
          { ...promptListRow, latestVersionId: "pv9", latestVersion: 7, versionCount: 3 },
        ],
        total: 1,
      })),
      findTagsByVersionIds,
    });
    const service = new PromptsService(repo);
    const res = await service.list({ page: 1, pageSize: 10 });
    expect(findTagsByVersionIds).toHaveBeenCalledWith(["pv9"]);
    expect(res.items[0].latestVersion).toBe(7);
    expect(res.items[0].tags).toEqual(["production"]);
    expect(res.items[0].variables).toEqual(["query"]);
    expect(res.total).toBe(1);
  });
});

describe("PromptsService · 标签移动/摘除", () => {
  it("moveTag：版本属于该 Prompt → upsert + 返回标签列表", async () => {
    const upsertTag = jest.fn(async () => undefined);
    const repo = makeRepo({
      findVersionById: jest.fn(async () => versionRow),
      upsertTag,
      findTagsWithVersion: jest.fn(async () => [
        { name: "production", versionId: "pv1", version: 1 },
      ]),
    });
    const service = new PromptsService(repo);
    const res = await service.moveTag("p1", "production", "pv1", "actor@x");
    expect(upsertTag).toHaveBeenCalledWith("p1", "pv1", "production", "actor@x");
    expect(res).toEqual([{ name: "production", versionId: "pv1", version: 1 }]);
  });

  it("moveTag：版本不属于该 Prompt → NotFoundException 且不 upsert", async () => {
    const upsertTag = jest.fn();
    const repo = makeRepo({
      findVersionById: jest.fn(async () => ({ ...versionRow, promptId: "other" })),
      upsertTag,
    });
    const service = new PromptsService(repo);
    await expect(service.moveTag("p1", "t", "pv1", "a@x")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(upsertTag).not.toHaveBeenCalled();
  });

  it("moveTag：预检后版本被删（upsert 抛 23503）→ NotFoundException", async () => {
    const repo = makeRepo({
      findVersionById: jest.fn(async () => versionRow),
      upsertTag: jest.fn().mockRejectedValue({ code: "23503" }),
    });
    const service = new PromptsService(repo);
    await expect(service.moveTag("p1", "t", "pv1", "a@x")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("removeTag：入参归一小写后删除；0 行 → NotFoundException", async () => {
    const deleteTag = jest.fn(async () => 1);
    const repo = makeRepo({ deleteTag });
    const service = new PromptsService(repo);
    await service.removeTag("p1", "PRODUCTION");
    expect(deleteTag).toHaveBeenCalledWith("p1", "production");

    const repo2 = makeRepo({ deleteTag: jest.fn(async () => 0) });
    const service2 = new PromptsService(repo2);
    await expect(service2.removeTag("p1", "nope")).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("PromptsService · 节点全版本候选", () => {
  it("返回节点下全部版本（含无标签），标签仅作信号", async () => {
    const repo = makeRepo({
      findNodeVersionCandidates: jest.fn(async () => [
        {
          promptId: "p1",
          promptName: "回复生成-通用",
          versionId: "pv2",
          version: 2,
          compileStatus: "ok",
          body: "b",
          node: "reply",
          createdAt: now,
        },
        {
          promptId: "p1",
          promptName: "回复生成-通用",
          versionId: "pv1",
          version: 1,
          compileStatus: null, // 兼容窗口旧行 → 按需重算
          body: "{bad_var}",
          node: "reply",
          createdAt: now,
        },
      ]),
      findTagsByVersionIds: jest.fn(async () => [{ promptVersionId: "pv2", name: "production" }]),
    });
    const service = new PromptsService(repo);
    const res = await service.nodeVersionCandidates("reply");
    expect(res).toHaveLength(2);
    expect(res[0].tags).toEqual(["production"]);
    expect(res[1].tags).toEqual([]);
    expect(res[1].compileStatus).toBe("has_errors");
  });
});

describe("PromptsService · 删除与跨域元数据", () => {
  it("delete：FK RESTRICT（wrapped cause 23503）→ 可读 409", async () => {
    const fkError = Object.assign(new Error("violates foreign key constraint"), {
      cause: { code: "23503" },
    });
    const repo = makeRepo({
      deletePrompt: jest.fn(async () => {
        throw fkError;
      }),
    });
    const service = new PromptsService(repo);
    await expect(service.delete("p1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("delete：不存在 → 404；非 FK 错误原样抛", async () => {
    const repo = makeRepo({ findPromptById: jest.fn(async () => undefined) });
    await expect(new PromptsService(repo).delete("p1")).rejects.toBeInstanceOf(NotFoundException);

    const repo2 = makeRepo({
      deletePrompt: jest.fn(async () => {
        throw new Error("boom");
      }),
    });
    await expect(new PromptsService(repo2).delete("p1")).rejects.toThrow("boom");
  });

  it("delete：无「已发布不可删」语义——正常删除直达 repo", async () => {
    const deletePrompt = jest.fn(async () => undefined);
    const repo = makeRepo({ deletePrompt });
    await new PromptsService(repo).delete("p1");
    expect(deletePrompt).toHaveBeenCalledWith("p1");
  });

  it("getVersionMeta 扩展返回 {promptId, node, version}；不存在 → null", async () => {
    const repo = makeRepo({
      findVersionById: jest.fn(async (id: string) =>
        id === "pv1" ? { ...versionRow, version: 5 } : undefined,
      ),
    });
    const service = new PromptsService(repo);
    expect(await service.getVersionMeta("pv1")).toEqual({
      promptId: "p1",
      node: "reply",
      version: 5,
    });
    expect(await service.getVersionMeta("nope")).toBeNull();
  });
});
