import { ConflictException } from "@nestjs/common";
import { ApplicationsService } from "../src/modules/applications/applications.service";
import { EvalRunDeletionGuard } from "../src/modules/eval-runs/eval-run-deletion.guard";
import type { EvalRunsRepository } from "../src/modules/eval-runs/eval-runs.repository";

/**
 * E-W2b F6：应用删除守卫注册表（018 缺口 5）。多 guard、首个拒绝生效；guard 抛错不吞。
 * eval-runs 侧：活跃 run 引用 → 拦；仅终态 run → 放行。
 */

function makeService(deleteReturn = 1): {
  service: ApplicationsService;
  deleteApplication: jest.Mock;
} {
  const deleteApplication = jest.fn(async () => deleteReturn);
  const repo = { deleteApplication } as unknown;
  // 只用到 repo.deleteApplication + 守卫表；其余依赖不触及本用例。
  const service = new ApplicationsService(
    repo as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, deleteApplication };
}

describe("ApplicationsService 删除守卫", () => {
  it("注册两枚 guard：第一枚 null、第二枚拒绝 → delete 抛 409 带理由", async () => {
    const { service, deleteApplication } = makeService();
    service.registerDeletionGuard(async () => null);
    service.registerDeletionGuard(async () => "有评测正在运行引用该应用的配置版本，无法删除");
    await expect(service.delete("app1")).rejects.toBeInstanceOf(ConflictException);
    await expect(service.delete("app1")).rejects.toThrow("有评测正在运行");
    expect(deleteApplication).not.toHaveBeenCalled();
  });

  it("全部 guard 返回 null → 照常软删", async () => {
    const { service, deleteApplication } = makeService();
    service.registerDeletionGuard(async () => null);
    await service.delete("app1");
    expect(deleteApplication).toHaveBeenCalledWith("app1");
  });

  it("guard 抛错 → 冒泡（不吞，删除诚实报错）", async () => {
    const { service, deleteApplication } = makeService();
    service.registerDeletionGuard(async () => {
      throw new Error("guard boom");
    });
    await expect(service.delete("app1")).rejects.toThrow("guard boom");
    expect(deleteApplication).not.toHaveBeenCalled();
  });
});

describe("EvalRunDeletionGuard", () => {
  const guardOf = (active: boolean) => {
    const registered: Array<(id: string) => Promise<string | null>> = [];
    const applications = {
      registerDeletionGuard: (g: (id: string) => Promise<string | null>) => registered.push(g),
    } as unknown as ApplicationsService;
    const repo = {
      existsActiveRunByApplicationId: jest.fn(async () => active),
    } as unknown as EvalRunsRepository;
    const guard = new EvalRunDeletionGuard(applications, repo);
    guard.onModuleInit();
    return registered[0];
  };

  it("活跃 run 引用 → 返回拒绝理由", async () => {
    expect(await guardOf(true)("app1")).toBe("有评测正在运行引用该应用的配置版本，无法删除");
  });

  it("仅终态 run（无活跃）→ 返回 null（放行）", async () => {
    expect(await guardOf(false)("app1")).toBeNull();
  });
});
