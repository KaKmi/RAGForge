import { buildMetricTraceLink, toOverviewQuery } from "./qualityViewModel";

describe("qualityViewModel", () => {
  const now = new Date("2026-07-15T04:00:00.000Z");

  it("maps local today to local midnight and serializes UTC boundaries", () => {
    expect(toOverviewQuery("today", now, 480)).toEqual({
      from: "2026-07-14T16:00:00.000Z",
      to: "2026-07-15T04:00:00.000Z",
    });
  });

  it.each([
    ["7d", "2026-07-08T04:00:00.000Z"],
    ["30d", "2026-06-15T04:00:00.000Z"],
  ] as const)("maps %s to an exact rolling window", (range, from) => {
    expect(toOverviewQuery(range, now, 480)).toEqual({ from, to: now.toISOString() });
  });

  it("builds the documented Trace deep link", () => {
    expect(buildMetricTraceLink("faithfulness", 85, "2026-07-08T04:00:00.000Z")).toBe(
      "/admin/traces?evalMetric=faithfulness&evalMax=85&from=2026-07-08T04%3A00%3A00.000Z",
    );
  });
});
