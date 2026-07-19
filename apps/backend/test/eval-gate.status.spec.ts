import { EVAL_GATE_ISSUE_CODES } from "@codecrush/contracts";
import { ApplicationsService } from "../src/modules/applications/applications.service";

const now = new Date("2026-07-11T00:00:00.000Z");

/**
 * 只需要 `mustFind`（走 findApplicationById）这一条读路径，故给一个最小假 repo，
 * 不复制 applications.service.spec.ts 那份庞大的工厂（那份是给发布链路用的）。
 */
function service(app: Record<string, unknown> = {}) {
  const repo = {
    findApplicationById: jest.fn(async () => ({
      id: "app-1",
      slug: "after-sale",
      name: "售后",
      description: "",
      enabled: true,
      evalGateEnabled: false,
      productionConfigVersionId: null,
      productionVersion: null,
      latestVersion: 1,
      versionCount: 1,
      createdBy: "u",
      updatedBy: "u",
      createdAt: now,
      updatedAt: now,
      ...app,
    })),
    findTagNamesByAppIds: jest.fn(async () => new Map<string, string[]>()),
  };
  // 构造参数个数必须与真实构造函数一致（5 个）——backend 的 test/ 不过 tsc
  // （tsconfig include 只有 src），多写一个参数不会有任何编译期提示。
  return new ApplicationsService(
    repo as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe("getEvalGateStatus（B1/F5 门禁读端点）", () => {
  it("未注册 provider 时返回空 issues（applications 单模块启动不炸）", async () => {
    const svc = service({ evalGateEnabled: false });
    await expect(svc.getEvalGateStatus("app-1", "cv-1")).resolves.toEqual({
      enabled: false,
      issues: [],
    });
  });

  it("provider 抛异常 → fail-open，返回 UNAVAILABLE warning", async () => {
    const svc = service({ evalGateEnabled: true });
    svc.registerEvalGateProvider(async () => {
      throw new Error("clickhouse down");
    });
    const status = await svc.getEvalGateStatus("app-1", "cv-1");
    expect(status.enabled).toBe(true);
    expect(status.issues).toEqual([
      {
        code: EVAL_GATE_ISSUE_CODES.UNAVAILABLE,
        message: "评测数据暂不可用，未做回退判断",
        severity: "warning",
      },
    ]);
  });

  it("enabled 透出应用列值，不由 provider 决定", async () => {
    const svc = service({ evalGateEnabled: true });
    svc.registerEvalGateProvider(async () => []);
    await expect(svc.getEvalGateStatus("app-1", "cv-1")).resolves.toEqual({
      enabled: true,
      issues: [],
    });
  });

  /**
   * 【软提示不变量的钉，勿删】
   * provider 是 eval-runs 侧注册进来的外部回调。哪怕它（未来被改坏后）产出 error 级 issue，
   * 门禁也不得因此获得阻断力——阻断权只属于 staticGate 与预演。
   */
  it("provider 若产出 error 级 issue，也被强制降级为 warning", async () => {
    const svc = service({ evalGateEnabled: true });
    svc.registerEvalGateProvider(async () => [
      { code: "EVAL_GATE_REGRESSION", message: "存在 5 条回退用例", severity: "error" },
    ]);
    const status = await svc.getEvalGateStatus("app-1", "cv-1");
    expect(status.issues[0].severity).toBe("warning");
  });

  /**
   * 门禁跑在 ReleaseCheck 的异步 processor 里，取数要读两侧 run 的全量结果集，
   * 评测集一大就可能拖很久。超时必须按「读不到」处理并放行。
   */
  it("provider 超时 → fail-open，返回 UNAVAILABLE warning（不吊死 ReleaseCheck）", async () => {
    jest.useFakeTimers();
    try {
      const svc = service({ evalGateEnabled: true });
      svc.registerEvalGateProvider(() => new Promise(() => {})); // 永不 resolve
      const pending = svc.collectEvalGateIssues("app-1", "cv-1");
      await jest.advanceTimersByTimeAsync(5001);
      await expect(pending).resolves.toEqual([
        {
          code: EVAL_GATE_ISSUE_CODES.UNAVAILABLE,
          message: "评测数据暂不可用，未做回退判断",
          severity: "warning",
        },
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("重复注册 provider 会告警（覆盖而非追加是有意的，但不该静默）", async () => {
    const svc = service();
    const warn = jest.spyOn(svc["logger"], "warn").mockImplementation(() => undefined);
    svc.registerEvalGateProvider(async () => []);
    expect(warn).not.toHaveBeenCalled();
    svc.registerEvalGateProvider(async () => []);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("重复注册"));
  });

  it("collectEvalGateIssues 把 applicationId/configVersionId 原样传给 provider", async () => {
    const svc = service();
    const seen: string[][] = [];
    svc.registerEvalGateProvider(async (applicationId, configVersionId) => {
      seen.push([applicationId, configVersionId]);
      return [];
    });
    await svc.collectEvalGateIssues("app-9", "cv-9");
    expect(seen).toEqual([["app-9", "cv-9"]]);
  });
});
