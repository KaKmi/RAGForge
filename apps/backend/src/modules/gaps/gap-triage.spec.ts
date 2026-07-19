import {
  clusterKeyOf,
  detectFollowUp,
  isRewriteResolved,
  normalizeQuestion,
  shouldEnterPool,
  triageCluster,
  triageItem,
} from "./gap-triage";

describe("shouldEnterPool (原型 :378)", () => {
  const ok = {
    confidence: 90,
    fallbackUsed: false,
    noCitations: false,
    faithfulness: 90,
    answerRelevancy: 90,
    contextPrecision: 90,
  };
  it("keeps a healthy trace out", () => expect(shouldEnterPool(ok)).toBe(false));
  it("admits on low confidence (<60)", () =>
    expect(shouldEnterPool({ ...ok, confidence: 59 })).toBe(true));
  it("does not admit at exactly the confidence threshold (60)", () =>
    expect(shouldEnterPool({ ...ok, confidence: 60 })).toBe(false));
  it("admits on fallback", () => expect(shouldEnterPool({ ...ok, fallbackUsed: true })).toBe(true));
  it("admits on missing citations", () =>
    expect(shouldEnterPool({ ...ok, noCitations: true })).toBe(true));
  it("admits when any eval score < 70", () =>
    expect(shouldEnterPool({ ...ok, contextPrecision: 69 })).toBe(true));
  it("does not admit at exactly the eval threshold (70)", () =>
    expect(shouldEnterPool({ ...ok, contextPrecision: 70 })).toBe(false));
  it("does not treat an unscored (null) metric as low", () =>
    expect(shouldEnterPool({ ...ok, faithfulness: null })).toBe(false));
  it("does not treat a null confidence as low", () =>
    expect(shouldEnterPool({ ...ok, confidence: null })).toBe(false));
  it("keeps a fully unscored but otherwise healthy trace out", () =>
    expect(
      shouldEnterPool({
        ...ok,
        confidence: null,
        faithfulness: null,
        answerRelevancy: null,
        contextPrecision: null,
      }),
    ).toBe(false));
  it("still admits on the min of the non-null scores when others are null", () =>
    expect(
      shouldEnterPool({ ...ok, faithfulness: null, answerRelevancy: null, contextPrecision: 12 }),
    ).toBe(true));
});

describe("normalizeQuestion", () => {
  it("trims and collapses internal whitespace", () => {
    expect(normalizeQuestion("  管理   是  什么  ")).toBe("管理 是 什么");
  });
  it("strips trailing punctuation (full-width and half-width)", () => {
    expect(normalizeQuestion("还有那个点呢？")).toBe("还有那个点呢");
    expect(normalizeQuestion("what about that?")).toBe("what about that");
    expect(normalizeQuestion("好的。")).toBe("好的");
    expect(normalizeQuestion("真的吗！！？")).toBe("真的吗");
  });
  it("does not strip punctuation from the middle", () => {
    expect(normalizeQuestion("A？B")).toBe("A？B");
  });
  it("handles an empty / punctuation-only string without throwing", () => {
    expect(normalizeQuestion("   ")).toBe("");
    expect(normalizeQuestion("？？？")).toBe("");
  });
});

describe("isRewriteResolved (决策 G，spec §10.3)", () => {
  it("is false only when a non-first turn came back textually unchanged", () => {
    expect(
      isRewriteResolved({
        isFirstTurnInSession: false,
        raw: "还有上面说的某某点需要注意什么",
        rewritten: "还有上面说的某某点需要注意什么",
      }),
    ).toBe(false);
  });
  it("is true when the rewrite actually resolved the reference", () => {
    expect(
      isRewriteResolved({
        isFirstTurnInSession: false,
        raw: "还有上面说的某某点需要注意什么",
        rewritten: "管理中的授权要点需要注意什么",
      }),
    ).toBe(true);
  });
  it("is true on a first turn even if unchanged (nothing to resolve)", () => {
    expect(
      isRewriteResolved({ isFirstTurnInSession: true, raw: "管理是什么", rewritten: "管理是什么" }),
    ).toBe(true);
  });
  it("is true on a first turn even when the rewrite is missing", () => {
    expect(
      isRewriteResolved({ isFirstTurnInSession: true, raw: "管理是什么", rewritten: null }),
    ).toBe(true);
  });
  it("normalizes whitespace and trailing punctuation before comparing", () => {
    expect(
      isRewriteResolved({
        isFirstTurnInSession: false,
        raw: "还有那个点呢",
        rewritten: " 还有那个点呢？ ",
      }),
    ).toBe(false); // 实质未变
  });
  it("treats a missing rewrite as unresolved on a non-first turn", () => {
    expect(
      isRewriteResolved({ isFirstTurnInSession: false, raw: "还有那个点呢", rewritten: null }),
    ).toBe(false);
  });
});

describe("clusterKeyOf", () => {
  it("prefers the rewritten question", () => {
    expect(clusterKeyOf({ question: "还有那个点呢", rewrittenQuestion: "授权要点是什么" })).toBe(
      "授权要点是什么",
    );
  });
  it("falls back to the raw question when there is no rewrite", () => {
    expect(clusterKeyOf({ question: "还有那个点呢", rewrittenQuestion: null })).toBe(
      "还有那个点呢",
    );
  });
});

describe("detectFollowUp (缺口 23，021 决策 E；spec §10.4 改为直接测量)", () => {
  it("needs BOTH an unresolved rewrite AND near-zero precision", () => {
    expect(detectFollowUp({ rewriteResolved: false, contextPrecision: 10 })).toBe(true);
    expect(detectFollowUp({ rewriteResolved: true, contextPrecision: 0 })).toBe(false);
    expect(detectFollowUp({ rewriteResolved: false, contextPrecision: 11 })).toBe(false);
    expect(detectFollowUp({ rewriteResolved: false, contextPrecision: null })).toBe(false);
  });
});

describe("triageItem (原型 :371)", () => {
  it("missing: low confidence AND low precision", () =>
    expect(triageItem({ confidence: 30, contextPrecision: 40, faithfulness: 80 })).toBe("missing"));
  it("retrieval: low precision but confidence not low", () =>
    expect(triageItem({ confidence: 70, contextPrecision: 40, faithfulness: 80 })).toBe(
      "retrieval",
    ));
  it("generation: high precision but low faithfulness", () =>
    expect(triageItem({ confidence: 80, contextPrecision: 85, faithfulness: 50 })).toBe(
      "generation",
    ));
  it("falls back to missing when nothing matches (待人工分诊)", () =>
    expect(triageItem({ confidence: 80, contextPrecision: 85, faithfulness: 90 })).toBe("missing"));
  it("does not read a null score as low, so an unscored trace falls back to missing", () =>
    expect(triageItem({ confidence: null, contextPrecision: null, faithfulness: null })).toBe(
      "missing",
    ));
});

describe("triageCluster", () => {
  it("takes the mode of member verdicts", () =>
    expect(triageCluster(["missing", "missing", "retrieval"], 0)).toBe("missing"));
  it("breaks ties deterministically by severity order missing>retrieval>generation", () =>
    expect(triageCluster(["retrieval", "generation"], 0)).toBe("retrieval"));
  it("breaks a three-way tie toward missing", () =>
    expect(triageCluster(["missing", "retrieval", "generation"], 0)).toBe("missing"));
  it("FORCES retrieval when followUpRatio > 0.5, never missing (021 决策 E)", () =>
    expect(triageCluster(["missing", "missing", "missing"], 0.6)).toBe("retrieval"));
  it("does not force at exactly 0.5", () =>
    expect(triageCluster(["missing", "missing"], 0.5)).toBe("missing"));
  it("leaves a generation-mode cluster forced to retrieval too (force applies last)", () =>
    expect(triageCluster(["generation", "generation"], 0.9)).toBe("retrieval"));
  it("falls back to missing for an empty cluster", () =>
    expect(triageCluster([], 0)).toBe("missing"));
});
