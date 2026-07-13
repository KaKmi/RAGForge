import {
  CHAT_INTENT_KEY,
  UNKNOWN_INTENT_KEY,
  type FallbackReason,
} from "@codecrush/contracts";

/**
 * confidence = 被引用条目分数的最大值（F4：收 number[] 而非 hit——
 * citation.score 与 hit.finalScore 字段名不同，由调用方各自取分）。
 */
export function deriveConfidence(scores: number[]): number | undefined {
  return scores.length ? Math.max(...scores) : undefined;
}

/**
 * coverage：兜底→partial；正文无 [n] 角标→partial；
 * 任一角标越界 [1..citationCount]→partial；否则 full（且要求 ≥1 条引用）。
 */
export function deriveCoverage(
  replyText: string,
  citationCount: number,
  isFallback: boolean,
): "full" | "partial" {
  if (isFallback) return "partial";
  const marks = [...replyText.matchAll(/\[(\d+)\]/g)].map((m) =>
    Number(m[1]),
  );
  if (marks.length === 0) return "partial";
  const allLegal = marks.every((n) => n >= 1 && n <= citationCount);
  return allLegal && citationCount >= 1 ? "full" : "partial";
}

/**
 * 兜底判定（014 修订：去掉 base plan 的 intent==="unknown" 判据——
 * UNKNOWN 在上游路由为全量 KB 召回，本身不是兜底原因；
 * "chitchat" 由编排层 CHAT 短路产生，"out_of_scope" v1 不在此产出）。
 */
export function decideFallback(a: {
  topScore?: number;
  hitCount: number;
  threshold: number;
  scopeKbNames: string[];
}): {
  isFallback: boolean;
  reasons: FallbackReason[];
  topScore?: number;
  threshold: number;
  scopeKbNames: string[];
} {
  const reasons: FallbackReason[] = [];
  if (a.hitCount === 0) reasons.push("empty_retrieval");
  else if ((a.topScore ?? 0) < a.threshold) reasons.push("low_similarity");
  const isFallback = reasons.length > 0;
  if (isFallback) reasons.push("handled_by_fallback");
  return {
    isFallback,
    reasons,
    topScore: a.topScore,
    threshold: a.threshold,
    scopeKbNames: a.scopeKbNames,
  };
}

/**
 * M8 T3 §5 质量信号自动判定（写为 chain span 四布尔，供 M9 汇入 Badcase 池）：
 * - lowRecall：最高分低于阈值（low_similarity）或空召回（empty_retrieval）
 * - noCitations：无引用（citations 空）
 * - refusal：生成拒答（走了兜底话术，含 CHAT 短路 / 低分兜底 / reply 节点降级）
 * - timeout：reply 首 token 超时熔断
 * 四布尔各自独立可筛（非互斥）；no_citations 与 refusal 在兜底路径常同真，设计使然。
 */
export function deriveQualitySignals(a: {
  isFallback: boolean;
  reasons: FallbackReason[];
  citationCount: number;
  timedOut: boolean;
}): { lowRecall: boolean; noCitations: boolean; refusal: boolean; timeout: boolean } {
  return {
    lowRecall: a.reasons.includes("low_similarity") || a.reasons.includes("empty_retrieval"),
    noCitations: a.citationCount === 0,
    refusal: a.isFallback,
    timeout: a.timedOut,
  };
}

/**
 * 014 §D4 意图路由映射：
 * - CHAT → []（不检索，编排层短路到兜底）
 * - UNKNOWN → cfg.kbIds（全量召回）
 * - 业务 key K → 绑定 K 的 KB ∪ 未绑定（通配）KB；结果为空回退 cfg.kbIds
 */
export function resolveRetrievalKbIds(
  intent: string,
  cfg: { kbIds: string[] },
  kbRows: Array<{ id: string; intentKey: string | null }>,
): string[] {
  if (intent === CHAT_INTENT_KEY) return [];
  if (intent === UNKNOWN_INTENT_KEY) return cfg.kbIds;
  const matched = kbRows
    .filter((k) => k.intentKey === intent || k.intentKey == null)
    .map((k) => k.id);
  return matched.length ? matched : cfg.kbIds;
}
