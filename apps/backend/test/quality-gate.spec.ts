import { GateStage, runQualityGate } from "../src/modules/ingestion/pipeline/quality-gate";

const GATE = {
  maxCleanReductionRatio: 0.8,
  maxCanonicalBytes: 1024,
  maxBlocks: 10,
  maxChunkTokens: 512,
};

describe("runQualityGate", () => {
  it("parse 后 markdown 为空时报 PARSE_EMPTY", () => {
    expect(() =>
      runQualityGate(GateStage.AfterParse, GATE, { markdown: "", blocks: 0, rawLength: 0 }),
    ).toThrow(/PARSE_EMPTY/);
  });

  it("清洗删减超过 80% 报 CLEAN_SUSPICIOUS，边界值放行", () => {
    expect(() =>
      runQualityGate(GateStage.AfterNormalize, GATE, {
        markdown: "abc",
        blocks: 1,
        rawLength: 100,
      }),
    ).toThrow(/CLEAN_SUSPICIOUS/);
    expect(() =>
      runQualityGate(GateStage.AfterNormalize, GATE, {
        markdown: "a".repeat(20),
        blocks: 1,
        rawLength: 100,
      }),
    ).not.toThrow();
  });

  it("canonical bytes 或 blocks 超限时报 CANONICAL_TOO_LARGE", () => {
    expect(() =>
      runQualityGate(GateStage.AfterNormalize, GATE, {
        markdown: "x".repeat(2048),
        blocks: 1,
        rawLength: 2048,
      }),
    ).toThrow(/CANONICAL_TOO_LARGE/);
    expect(() =>
      runQualityGate(GateStage.AfterNormalize, GATE, {
        markdown: "ok",
        blocks: 11,
        rawLength: 2,
      }),
    ).toThrow(/CANONICAL_TOO_LARGE/);
  });

  it("chunk 为空或单块 token 超限时拒绝", () => {
    expect(() => runQualityGate(GateStage.AfterChunk, GATE, { chunkTexts: [] })).toThrow(
      /CHUNK_EMPTY/,
    );
    expect(() =>
      runQualityGate(GateStage.AfterChunk, GATE, { chunkTexts: ["短"] }),
    ).not.toThrow();
    expect(() =>
      runQualityGate(GateStage.AfterChunk, GATE, {
        chunkTexts: ["x".repeat(GATE.maxChunkTokens * 4 + 1)],
      }),
    ).toThrow(/CHUNK_OVERSIZED/);
  });
});
