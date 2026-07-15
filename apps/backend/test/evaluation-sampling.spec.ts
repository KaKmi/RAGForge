import {
  classifyRisk,
  effectiveNormalRate,
  evalDedupeKey,
  stableSample,
} from "../src/modules/evaluations/sampling";

describe("sampling", () => {
  it.each([
    [{ status: "failed", noCitations: false, confidence: 0.9 }, true],
    [{ status: "fallback", noCitations: false, confidence: 0.9 }, true],
    [{ status: "success", noCitations: true, confidence: 0.9 }, true],
    [{ status: "success", noCitations: false, confidence: 0.59 }, true],
    [{ status: "success", noCitations: false, confidence: 0.6 }, false],
    [{ status: "success", noCitations: false, confidence: null }, false],
  ] as const)("classifies risk boundary", (candidate, expected) => {
    expect(classifyRisk(candidate)).toBe(expected);
  });

  it("is stable and respects zero/one rate boundaries", () => {
    expect(stableSample("a".repeat(32), "online-v1", 0.1)).toBe(
      stableSample("a".repeat(32), "online-v1", 0.1),
    );
    expect(stableSample("a".repeat(32), "online-v1", 1)).toBe(true);
    expect(stableSample("a".repeat(32), "online-v1", 0)).toBe(false);
  });

  it("halves only the normal sampling rate after 80% of the daily cap", () => {
    expect(effectiveNormalRate(0.1, 399, 500)).toBe(0.1);
    expect(effectiveNormalRate(0.1, 400, 500)).toBe(0.05);
  });

  it("builds the exact lowercase SHA-256 target/version key", () => {
    expect(evalDedupeKey("trace", "online-v1")).toMatch(/^[a-f0-9]{64}$/);
    expect(evalDedupeKey("trace", "online-v1")).not.toBe(evalDedupeKey("trace", "online-v2"));
  });
});
