import { cosineSimilarity, updateCentroid, meanVector } from "./gap-clustering";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 10);
  });
  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });
  it("is scale invariant", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });
  it("returns 0 when either vector is all-zero (no NaN)", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 1], [0, 0])).toBe(0);
  });
  it("returns 0 on dimension mismatch instead of silently truncating", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0);
  });
  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
  it("is negative for opposed vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });
});

describe("updateCentroid", () => {
  it("averages the new vector in by frequency", () => {
    expect(updateCentroid([0, 0], 0, [2, 4])).toEqual([2, 4]);
    expect(updateCentroid([2, 4], 1, [4, 8])).toEqual([3, 6]);
  });
  it("equals meanVector over the same inputs", () => {
    const vs = [
      [1, 0],
      [3, 2],
      [5, 4],
    ];
    let c = vs[0];
    for (let i = 1; i < vs.length; i++) c = updateCentroid(c, i, vs[i]);
    expect(c[0]).toBeCloseTo(meanVector(vs)[0], 10);
    expect(c[1]).toBeCloseTo(meanVector(vs)[1], 10);
  });
  it("does not mutate its inputs", () => {
    const centroid = [2, 4];
    const v = [4, 8];
    updateCentroid(centroid, 1, v);
    expect(centroid).toEqual([2, 4]);
    expect(v).toEqual([4, 8]);
  });
});

describe("meanVector", () => {
  it("returns an empty vector for an empty input set", () => {
    expect(meanVector([])).toEqual([]);
  });
  it("returns the single vector unchanged (by value) for a one-element set", () => {
    expect(meanVector([[1, 2, 3]])).toEqual([1, 2, 3]);
  });
  it("averages component-wise", () => {
    expect(
      meanVector([
        [0, 10],
        [2, 20],
        [4, 30],
      ]),
    ).toEqual([2, 20]);
  });
});
