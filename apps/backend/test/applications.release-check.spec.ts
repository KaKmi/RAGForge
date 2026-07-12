import { computeFingerprint, type FingerprintInput } from "../src/modules/applications/fingerprint";
import { buildSamples } from "../src/modules/applications/release-check.samples";

const base: FingerprintInput = {
  configVersionId: "v1",
  prompts: [
    { node: "rewrite", promptVersionId: "pr", contractVersion: 1 },
    { node: "intent", promptVersionId: "pi", contractVersion: 1 },
  ],
  models: [
    { node: "rewrite", modelId: "m1", providerRevision: "2026-07-12T00:00:00.000Z" },
    { node: "intent", modelId: "m1", providerRevision: "2026-07-12T00:00:00.000Z" },
  ],
  rerankModelId: null,
  rerankProviderRevision: null,
  nodeParams: { rewrite: { temperature: 0.7 } },
  retrievalParams: { topK: 20 },
  fallbackParams: { toHuman: true },
  kbs: [
    { kbId: "kb-b", activeVersion: 2 },
    { kbId: "kb-a", activeVersion: 1 },
  ],
};

describe("computeFingerprint", () => {
  it("same input → same hash (64 hex)", () => {
    const a = computeFingerprint(base);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(computeFingerprint(base)).toBe(a);
  });
  it("kb ordering is irrelevant (stable sort)", () => {
    const reordered = { ...base, kbs: [...base.kbs].reverse() };
    expect(computeFingerprint(reordered)).toBe(computeFingerprint(base));
  });
  it("a changed KB active version changes the hash", () => {
    const changed = { ...base, kbs: [{ kbId: "kb-a", activeVersion: 9 }, { kbId: "kb-b", activeVersion: 2 }] };
    expect(computeFingerprint(changed)).not.toBe(computeFingerprint(base));
  });
  it("a changed provider revision changes the hash", () => {
    const changed = {
      ...base,
      models: [
        { node: "rewrite", modelId: "m1", providerRevision: "2026-07-13T00:00:00.000Z" },
        { node: "intent", modelId: "m1", providerRevision: "2026-07-12T00:00:00.000Z" },
      ],
    };
    expect(computeFingerprint(changed)).not.toBe(computeFingerprint(base));
  });
});

describe("buildSamples", () => {
  it("rewrite/intent yield 10 samples; reply/fallback yield 1", () => {
    expect(buildSamples("rewrite", [])).toHaveLength(10);
    expect(buildSamples("intent", ["r1"])).toHaveLength(10);
    expect(buildSamples("reply", [])).toHaveLength(1);
    expect(buildSamples("fallback", [])).toHaveLength(1);
  });
  it("intent passes availableRoutes into runtimeContext; reply gets citations:[]", () => {
    expect(buildSamples("intent", ["r1", "r2"])[0].runtimeContext).toEqual({
      availableRoutes: ["r1", "r2"],
    });
    expect(buildSamples("reply", [])[0].runtimeContext).toEqual({ citations: [] });
  });
  it("reply input carries retrievalContext; fallback input carries reason", () => {
    expect(buildSamples("reply", [])[0].input).toMatchObject({ retrievalContext: expect.any(String) });
    expect(buildSamples("fallback", [])[0].input).toMatchObject({ reason: expect.any(String) });
  });
});
