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
    findReleaseCheckById: jest.fn(async () => ({ id: "rc1", status: "queued", startedAt: null, configVersionId: "v1" })),
    findVersionById: jest.fn(async () => versionRow),
    findVersionKbIds: jest.fn(async () => ["kb1"]),
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
  const proc = new ReleaseCheckProcessor(
    queue as never,
    repo as never,
    nodeRuntime as never,
    prompts as never,
  );
  return { proc, repo, nodeRuntime, prompts };
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
        findReleaseCheckById: jest.fn(async () => ({ id: "rc1", status: "queued", startedAt: null, configVersionId: "v1" })),
        findVersionById: jest.fn(async () => versionRow),
        findVersionKbIds: jest.fn(async () => ["kb1"]),
        markReleaseCheckRunning: jest.fn(async () => undefined),
        markReleaseCheckResult: repo.markReleaseCheckResult,
      } as never,
      nrFail as never,
      { getVersionExecutable: jest.fn(async () => ({ node: "reply", contractVersion: 1, body: "{query}" })) } as never,
    );
    await proc2.process("rc1");
    const result = repo.markReleaseCheckResult.mock.calls[0][1];
    expect(result.status).toBe("failed");
    expect(result.expiresAt).toBeNull();
    expect(result.issues[0]).toMatchObject({ node: "rewrite", traceId: "b".repeat(32), action: "OPEN_PROMPT_TRY_RUN" });
  });

  it("version missing → failed VERSION_MISSING, no sampling", async () => {
    const { proc, repo, nodeRuntime } = make({ findVersionById: jest.fn(async () => undefined) });
    await proc.process("rc1");
    expect(nodeRuntime.compileAndSample).not.toHaveBeenCalled();
    expect(repo.markReleaseCheckResult.mock.calls[0][1].issues[0].code).toBe("VERSION_MISSING");
  });
});
