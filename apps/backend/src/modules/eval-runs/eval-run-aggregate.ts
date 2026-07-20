import type { EvalMetricKey, EvalRunRepeat, EvalRunResult, EvalVerdict } from "@codecrush/contracts";
import { decideVerdict } from "./eval-run-worker.processor";
import type { EvalRunResultWithCase } from "./eval-runs.repository";

/**
 * E-W2b F5：把一个用例的多次重复行聚合成一条报告行（屏3 记分卡 / 屏4 对比**同源**——
 * Task 9 复用本函数，二者数值必然一致）。
 *
 * 聚合口径（§14「取均值」）：
 *  · 每指标对**非 NULL** 重复值取均值四舍五入（NULL 不进分母——不变量 2）；
 *  · 聚合 verdict：全部重复 timeout → 'timeout'；否则 `decideVerdict(聚合的四个 argmin 分)`；
 *  · minMetric/minScore 由聚合分 argmin（citation/检索三项**不进** argmin，diff D1）；
 *  · 顶层 answer/previewTraceId/evidence 取 repeatIndex 最小的行（明细在 repeats）。
 *
 * `rows` 必须同属一个 caseVersionId。repeatCount=1 时退化为恒等（顶层 == repeats[0]）。
 */
export function aggregateCaseRows(rows: EvalRunResultWithCase[]): EvalRunResult {
  const ordered = [...rows].sort((a, b) => a.repeatIndex - b.repeatIndex);
  const first = ordered[0];

  const mean = (key: keyof EvalRunResultWithCase): number | null => {
    const vals = ordered
      .map((r) => r[key])
      .filter((v): v is number => typeof v === "number");
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  };

  const scores = {
    faithfulness: mean("faithfulness"),
    answerRelevancy: mean("answerRelevancy"),
    contextPrecision: mean("contextPrecision"),
    correctness: mean("correctness"),
  };
  const allTimeout = ordered.every((r) => r.verdict === "timeout");
  const decision = decideVerdict(scores);
  const verdict: EvalVerdict = allTimeout ? "timeout" : decision.verdict;

  const repeats: EvalRunRepeat[] = ordered.map((r) => ({
    repeatIndex: r.repeatIndex,
    faithfulness: r.faithfulness,
    answerRelevancy: r.answerRelevancy,
    contextPrecision: r.contextPrecision,
    correctness: r.correctness,
    citation: r.citation,
    contextRecall: r.contextRecall,
    ndcg5: r.ndcg5,
    hitRate5: r.hitRate5,
    verdict: r.verdict as EvalVerdict,
    previewTraceId: r.previewTraceId,
    answer: r.answer,
    durationMs: r.durationMs,
    error: r.error,
    evidence: r.evidence as EvalRunRepeat["evidence"],
  }));

  return {
    seq: first.seq,
    caseId: first.caseId,
    caseVersion: first.caseVersion,
    question: first.question,
    faithfulness: scores.faithfulness,
    answerRelevancy: scores.answerRelevancy,
    contextPrecision: scores.contextPrecision,
    correctness: scores.correctness,
    citation: mean("citation"),
    contextRecall: mean("contextRecall"),
    ndcg5: mean("ndcg5"),
    hitRate5: mean("hitRate5"),
    minMetric: decision.minMetric as EvalMetricKey | null,
    minScore: decision.minScore,
    verdict,
    evidence: first.evidence as EvalRunResult["evidence"],
    previewTraceId: first.previewTraceId,
    answer: first.answer,
    // per-case durationMs = 各重复之和（repeatCount=1 时 == 单次，与 W2a 逐字节一致）。
    durationMs: ordered.reduce((acc, r) => acc + r.durationMs, 0),
    error: first.error,
    repeatCount: ordered.length,
    repeats,
    /**
     * B2b「标记忽略」是**逐 case** 粒度：写侧一次 UPDATE 覆盖该 case 的全部 repeat 行，
     * 故这里取第一行即可代表整组。用 `?? null` 而不是 `first.ignoredAt` 直传：
     * 老 run 的行在迁移 0028 之前建，该列为 NULL，语义就是「未忽略」。
     */
    ignoredAt: first.ignoredAt ? first.ignoredAt.toISOString() : null,
  };
}

/** 按 caseVersionId 分组 → 每组聚合 → 按 minScore 升序（NULLS LAST）+ seq 排序（原型 §7 坏的浮顶）。 */
export function aggregateResults(rows: EvalRunResultWithCase[]): EvalRunResult[] {
  const groups = new Map<string, EvalRunResultWithCase[]>();
  for (const row of rows) {
    const list = groups.get(row.caseVersionId);
    if (list) list.push(row);
    else groups.set(row.caseVersionId, [row]);
  }
  const aggregated = [...groups.values()].map(aggregateCaseRows);
  return aggregated.sort((a, b) => {
    if (a.minScore === null && b.minScore === null) return a.seq - b.seq;
    if (a.minScore === null) return 1;
    if (b.minScore === null) return -1;
    return a.minScore - b.minScore || a.seq - b.seq;
  });
}
