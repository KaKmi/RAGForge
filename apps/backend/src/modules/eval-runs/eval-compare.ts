import type {
  CompareMetricKey,
  EvalCompareResponse,
  EvalRunListItem,
  EvalRunResult,
  EvalVerdict,
} from "@codecrush/contracts";

/** F8 对比的 8 个指标键（4 argmin + citation + 3 检索 gold）。 */
export const COMPARE_METRIC_KEYS: readonly CompareMetricKey[] = [
  "faithfulness",
  "answerRelevancy",
  "contextPrecision",
  "correctness",
  "citation",
  "contextRecall",
  "ndcg5",
  "hitRate5",
] as const;

/** verdict 降档序：pass>weak>low；timeout/unscored 不参与降档判定（任一侧非判定态 → excluded）。 */
const VERDICT_RANK: Partial<Record<EvalVerdict, number>> = { pass: 3, weak: 2, low: 1 };

const SIGNIFICANT_DELTA = 3;
const SIGNIFICANT_SAMPLE = 30;
const CASE_DRIFT = 10;

interface MetricStat {
  value: number | null;
  scoredCount: number;
}

function metricStat(results: EvalRunResult[], key: CompareMetricKey): MetricStat {
  const vals = results.map((r) => r[key]).filter((v): v is number => v !== null);
  return {
    value: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null,
    scoredCount: vals.length,
  };
}

/** per-case 分类：regressed（降档或任一共有指标降≥10）/ improved（对称且无回退）/ excluded（任一侧非判定态）。 */
export function classifyCase(
  a: EvalRunResult,
  b: EvalRunResult,
): { regressed: boolean; improved: boolean; excluded: boolean } {
  const ar = VERDICT_RANK[a.verdict];
  const br = VERDICT_RANK[b.verdict];
  if (ar === undefined || br === undefined) {
    return { regressed: false, improved: false, excluded: true };
  }
  let anyDrop = false;
  let anyRise = false;
  for (const key of COMPARE_METRIC_KEYS) {
    const av = a[key];
    const bv = b[key];
    if (av !== null && bv !== null) {
      if (bv - av <= -CASE_DRIFT) anyDrop = true;
      if (bv - av >= CASE_DRIFT) anyRise = true;
    }
  }
  const regressed = br < ar || anyDrop;
  const improved = (br > ar || anyRise) && !regressed;
  return { regressed, improved, excluded: false };
}

function caseScores(r: EvalRunResult): Partial<Record<CompareMetricKey, number | null>> {
  const scores: Partial<Record<CompareMetricKey, number | null>> = {};
  for (const key of COMPARE_METRIC_KEYS) scores[key] = r[key];
  return scores;
}

function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

export interface CompareRunInput {
  summary: EvalRunListItem & { judgeModelId: string; offlineJudgeVersion: string; tokensUsed: number };
  results: EvalRunResult[];
}

/**
 * F8：构造对比响应（纯函数——service 取数后调用）。metrics 聚合值与屏3 记分卡**同源**
 * （aggregateResults 产出的 case 级均值）。significant = |delta|≥3 且两侧 scoredCount≥30。
 */
export function buildCompareResponse(a: CompareRunInput, b: CompareRunInput): EvalCompareResponse {
  const metrics = COMPARE_METRIC_KEYS.map((key) => {
    const as = metricStat(a.results, key);
    const bs = metricStat(b.results, key);
    const delta = as.value !== null && bs.value !== null ? bs.value - as.value : null;
    const significant =
      delta !== null &&
      Math.abs(delta) >= SIGNIFICANT_DELTA &&
      as.scoredCount >= SIGNIFICANT_SAMPLE &&
      bs.scoredCount >= SIGNIFICANT_SAMPLE;
    return { key, a: as.value, b: bs.value, delta, significant };
  });

  const bByCase = new Map(b.results.map((r) => [r.caseId, r]));
  let improvedCount = 0;
  let regressedCount = 0;
  let flatCount = 0;
  let excludedCount = 0;
  const cases = a.results.flatMap((ar) => {
    const br = bByCase.get(ar.caseId);
    if (!br) return [];
    const cls = classifyCase(ar, br);
    if (cls.excluded) excludedCount += 1;
    else if (cls.regressed) regressedCount += 1;
    else if (cls.improved) improvedCount += 1;
    else flatCount += 1;
    return [
      {
        caseId: ar.caseId,
        seq: ar.seq,
        question: ar.question,
        a: {
          verdict: ar.verdict,
          minScore: ar.minScore,
          scores: caseScores(ar),
          answer: ar.answer,
          traceId: ar.previewTraceId,
        },
        b: {
          verdict: br.verdict,
          minScore: br.minScore,
          scores: caseScores(br),
          answer: br.answer,
          traceId: br.previewTraceId,
        },
        regressed: cls.regressed,
        improved: cls.improved,
      },
    ];
  });

  const overallDelta =
    a.summary.overallScore !== null && b.summary.overallScore !== null
      ? b.summary.overallScore - a.summary.overallScore
      : null;
  const caseCount = (n: number) => (n === 0 ? null : n);
  return {
    a: a.summary,
    b: b.summary,
    metrics,
    latency: {
      aP95Ms: p95(a.results.map((r) => r.durationMs)),
      bP95Ms: p95(b.results.map((r) => r.durationMs)),
    },
    tokens: {
      aAvgPerCase:
        caseCount(a.results.length) === null
          ? null
          : Math.round(a.summary.tokensUsed / a.results.length),
      bAvgPerCase:
        caseCount(b.results.length) === null
          ? null
          : Math.round(b.summary.tokensUsed / b.results.length),
    },
    cases,
    summary: {
      overallDelta,
      improvedCount,
      regressedCount,
      flatCount,
      excludedCount,
      judgeMismatch: a.summary.judgeModelId !== b.summary.judgeModelId,
    },
  };
}
