import { ClickHouseEvaluationsRepository } from "../src/modules/evaluations/clickhouse-evaluations.repository";

describe("ClickHouseEvaluationsRepository", () => {
  it("uses the composite cursor, excludes preview, and parses every retrieval payload", async () => {
    const json = jest.fn().mockResolvedValue([
      {
        trace_id: "a".repeat(32),
        start_time: "2026-07-15 01:30:00.000000000",
        agent_id: "app-1",
        status: "success",
        no_citations: 0,
        generation_model: "qwen",
        confidence: "0.7",
        chunk_score_payloads: [
          JSON.stringify([{ chunkId: "c1", final: 0.9 }]),
          "malformed",
          JSON.stringify([{ chunkId: "c2", final: 0.8 }]),
        ],
      },
    ]);
    const query = jest.fn().mockResolvedValue({ json });
    const repo = new ClickHouseEvaluationsRepository({ query } as never);
    const cursor = { lastTs: new Date("2026-07-15T01:00:00.000Z"), lastTraceId: "0".repeat(32) };
    const rows = await repo.listCandidates(cursor, new Date("2026-07-15T01:55:00.000Z"), 500);
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("t.preview = 0"),
        query_params: expect.objectContaining({
          lastTs: cursor.lastTs.toISOString(),
          lastTraceId: cursor.lastTraceId,
          limit: 500,
        }),
      }),
    );
    expect(rows[0].retrievalChunks).toEqual([
      { chunkId: "c1", finalScore: 0.9 },
      { chunkId: "c2", finalScore: 0.8 },
    ]);
    expect(rows[0].confidence).toBe(0.7);
  });

  it("checks an existing success by target and version", async () => {
    const json = jest.fn().mockResolvedValue([{ target_trace_id: "a".repeat(32) }]);
    const query = jest.fn().mockResolvedValue({ json });
    const repo = new ClickHouseEvaluationsRepository({ query } as never);
    await expect(repo.findExisting("a".repeat(32), "online-v1")).resolves.toEqual({
      targetTraceId: "a".repeat(32),
    });
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        query_params: { targetTraceId: "a".repeat(32), judgeVersion: "online-v1" },
      }),
    );
  });
});
