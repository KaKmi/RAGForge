import { INTENT_TABLE } from "@codecrush/contracts";
import { ReleaseCheckProcessor } from "../src/modules/applications/release-check.processor";

const versionRow = {
  id: "v1",
  applicationId: "a1",
  promptRewriteVersionId: "pr",
  promptIntentVersionId: "pi",
  promptReplyVersionId: "pp",
  promptFallbackVersionId: "pf",
  rewriteModelId: "m",
  intentModelId: "m",
  replyModelId: "m",
  fallbackModelId: "m",
  nodeParams: {
    rewrite: { freedom: "balance", temperature: 0.7, topP: 0.9 },
    intent: { freedom: "balance", temperature: 0.7, topP: 0.9 },
    reply: { freedom: "balance", temperature: 0.7, topP: 0.9 },
    fallback: { freedom: "balance", temperature: 0.7, topP: 0.9 },
  },
} as never;

function make(overrides: Record<string, unknown> = {}) {
  const repo = {
    findReleaseCheckById: jest.fn(async () => ({ id: "rc1", status: "queued", startedAt: null, configVersionId: "v1", applicationId: "a1" })),
    findVersionById: jest.fn(async () => versionRow),
    markReleaseCheckRunning: jest.fn(async () => undefined),
    markReleaseCheckResult: jest.fn(async () => undefined),
    ...overrides,
  };
  const nodeRuntime = {
    compileAndSample: jest.fn(async () => ({
      ok: true,
      results: [{ sampleIndex: 0, ok: true, fallbackUsed: false, issues: [], traceId: "a".repeat(32) }],
    })),
  };
  const prompts = {
    getVersionExecutable: jest.fn(async () => ({ node: "reply", contractVersion: 1, body: "{query}" })),
  };
  const queue = { subscribe: jest.fn(async () => undefined), publish: jest.fn(async () => undefined) };
  // B1/F5：门禁 provider 未注册时 collectEvalGateIssues 返回 []，
  // 故这里给一个「无门禁结论」的假 ApplicationsService——既有断言的 issue 数不受影响。
  const applications = { collectEvalGateIssues: jest.fn(async () => []) };
  const proc = new ReleaseCheckProcessor(
    queue as never,
    repo as never,
    nodeRuntime as never,
    prompts as never,
    applications as never,
  );
  return { proc, repo, nodeRuntime, prompts, applications };
}

describe("ReleaseCheckProcessor", () => {
  it("terminal check (passed) → skip: no run, no compileAndSample", async () => {
    const { proc, repo, nodeRuntime } = make({
      findReleaseCheckById: jest.fn(async () => ({ id: "rc1", status: "passed", startedAt: null })),
    });
    await proc.process("rc1");
    expect(repo.markReleaseCheckRunning).not.toHaveBeenCalled();
    expect(nodeRuntime.compileAndSample).not.toHaveBeenCalled();
  });

  it("running within zombie window → skip", async () => {
    const { proc, repo } = make({
      findReleaseCheckById: jest.fn(async () => ({ id: "rc1", status: "running", startedAt: new Date() })),
    });
    await proc.process("rc1");
    expect(repo.markReleaseCheckRunning).not.toHaveBeenCalled();
  });

  it("queued + all nodes ok → markResult passed with expiry; 4 nodes sampled", async () => {
    const { proc, repo, nodeRuntime } = make();
    await proc.process("rc1");
    expect(repo.markReleaseCheckRunning).toHaveBeenCalledWith("rc1");
    expect(nodeRuntime.compileAndSample).toHaveBeenCalledTimes(4); // rewrite/intent/reply/fallback
    const result = repo.markReleaseCheckResult.mock.calls[0][1];
    expect(result.status).toBe("passed");
    expect(result.expiresAt).toBeInstanceOf(Date);
    // 014 D5：intent 冒烟样例注入静态全表 availableIntents（不再按 kbIds 派生子集）
    const intentCall = nodeRuntime.compileAndSample.mock.calls.find(
      (c: unknown[]) => (c[0] as { node: string }).node === "intent",
    );
    expect((intentCall![0] as { samples: { runtimeContext: unknown }[] }).samples[0].runtimeContext).toEqual({
      availableIntents: INTENT_TABLE,
    });
  });

  it("a failing sample → failed, issue carries node + traceId + OPEN_PROMPT_TRY_RUN", async () => {
    const { repo } = make({});
    const nrFail = {
      compileAndSample: jest.fn(async () => ({
        ok: false,
        results: [
          { sampleIndex: 0, ok: false, fallbackUsed: true, issues: [{ code: "EXTRA_VALIDATE", message: "越权" }], traceId: "b".repeat(32) },
        ],
      })),
    };
    // rebuild with failing runtime
    const proc2 = new ReleaseCheckProcessor(
      { subscribe: jest.fn(), publish: jest.fn() } as never,
      {
        findReleaseCheckById: jest.fn(async () => ({ id: "rc1", status: "queued", startedAt: null, configVersionId: "v1", applicationId: "a1" })),
        findVersionById: jest.fn(async () => versionRow),
        markReleaseCheckRunning: jest.fn(async () => undefined),
        markReleaseCheckResult: repo.markReleaseCheckResult,
      } as never,
      nrFail as never,
      { getVersionExecutable: jest.fn(async () => ({ node: "reply", contractVersion: 1, body: "{query}" })) } as never,
      { collectEvalGateIssues: jest.fn(async () => []) } as never,
    );
    await proc2.process("rc1");
    const result = repo.markReleaseCheckResult.mock.calls[0][1];
    expect(result.status).toBe("failed");
    expect(result.expiresAt).toBeNull();
    // B1/F5 回归钉：预演失败的 issue 必须是 error 级——否则 hasBlockingIssue 会把它当软提示放行。
    expect(result.issues[0]).toMatchObject({ node: "rewrite", traceId: "b".repeat(32), action: "OPEN_PROMPT_TRY_RUN", severity: "error" });
  });

  /**
   * 【软门禁不变量的钉，勿删】
   * 门禁 issue 进了 issues[]，但 status 必须仍是 passed、expiresAt 必须仍下发——
   * 否则 publishProduction 的 `status==='passed'` 校验会拒发布，软提示就变成了硬卡点。
   */
  it("B1/F5：门禁 warning 进 issues 但不阻断——status 仍 passed 且 expiresAt 仍下发", async () => {
    const { proc, repo, applications } = make();
    applications.collectEvalGateIssues = jest.fn(async () => [
      { code: "EVAL_GATE_REGRESSION", message: "存在 5 条回退用例", severity: "warning" },
      { code: "EVAL_GATE_STALE_RUN", message: "最近一次对比评测已超过 24 小时，结论可能过时", severity: "warning" },
    ]);
    await proc.process("rc1");
    const result = repo.markReleaseCheckResult.mock.calls[0][1];
    expect(result.status).toBe("passed");
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.issues.map((i: { code: string }) => i.code)).toEqual([
      "EVAL_GATE_REGRESSION",
      "EVAL_GATE_STALE_RUN",
    ]);
    // 门禁按应用+版本定位，两个参数都必须原样传下去
    expect(applications.collectEvalGateIssues).toHaveBeenCalledWith("a1", "v1");
  });

  it("B1/F5：门禁 warning 与预演 error 并存时，仍按 error 判 failed", async () => {
    const { repo } = make({});
    const proc2 = new ReleaseCheckProcessor(
      { subscribe: jest.fn(), publish: jest.fn() } as never,
      {
        findReleaseCheckById: jest.fn(async () => ({ id: "rc1", status: "queued", startedAt: null, configVersionId: "v1", applicationId: "a1" })),
        findVersionById: jest.fn(async () => versionRow),
        markReleaseCheckRunning: jest.fn(async () => undefined),
        markReleaseCheckResult: repo.markReleaseCheckResult,
      } as never,
      {
        compileAndSample: jest.fn(async () => ({
          ok: false,
          results: [{ sampleIndex: 0, ok: false, fallbackUsed: true, issues: [{ code: "EXTRA_VALIDATE", message: "越权" }], traceId: "b".repeat(32) }],
        })),
      } as never,
      { getVersionExecutable: jest.fn(async () => ({ node: "reply", contractVersion: 1, body: "{query}" })) } as never,
      {
        collectEvalGateIssues: jest.fn(async () => [
          { code: "EVAL_GATE_REGRESSION", message: "存在 5 条回退用例", severity: "warning" },
        ]),
      } as never,
    );
    await proc2.process("rc1");
    const result = repo.markReleaseCheckResult.mock.calls[0][1];
    expect(result.status).toBe("failed");
    expect(result.expiresAt).toBeNull();
  });

  it("version missing → failed VERSION_MISSING, no sampling", async () => {
    const { proc, repo, nodeRuntime } = make({ findVersionById: jest.fn(async () => undefined) });
    await proc.process("rc1");
    expect(nodeRuntime.compileAndSample).not.toHaveBeenCalled();
    expect(repo.markReleaseCheckResult.mock.calls[0][1].issues[0].code).toBe("VERSION_MISSING");
  });

  it("review P2-2：基础设施异常（如 DB 抖动）→ 标 failed INTERNAL_ERROR 而非永久卡 running", async () => {
    const { proc, repo } = make({
      findVersionById: jest.fn(async () => {
        throw new Error("db connection reset");
      }),
    });
    await proc.process("rc1");
    const result = repo.markReleaseCheckResult.mock.calls[0][1];
    expect(result.status).toBe("failed");
    expect(result.issues[0]).toMatchObject({ code: "INTERNAL_ERROR", message: "db connection reset" });
    expect(result.expiresAt).toBeNull();
  });
});
