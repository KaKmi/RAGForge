import type { QualityMetric, QualityOverviewQuery } from "@codecrush/contracts";

export type QualityRange = "today" | "7d" | "30d";

export function toOverviewQuery(
  range: QualityRange,
  now = new Date(),
  timezoneOffsetMinutes = -now.getTimezoneOffset(),
): QualityOverviewQuery {
  let from: Date;
  if (range === "today") {
    const shifted = new Date(now.getTime() + timezoneOffsetMinutes * 60_000);
    const localMidnightAsUtc = Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
    );
    from = new Date(localMidnightAsUtc - timezoneOffsetMinutes * 60_000);
  } else {
    const days = range === "7d" ? 7 : 30;
    from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  }
  return { from: from.toISOString(), to: now.toISOString() };
}

export function buildMetricTraceLink(metric: QualityMetric, max: number, from: string): string {
  const metricParam =
    metric === "answerRelevancy"
      ? "relevancy"
      : metric === "contextPrecision"
        ? "precision"
        : "faithfulness";
  const params = new URLSearchParams({ evalMetric: metricParam, evalMax: String(max), from });
  return `/admin/traces?${params.toString()}`;
}
