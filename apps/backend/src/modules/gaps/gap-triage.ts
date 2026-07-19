import {
  FOLLOWUP_PRECISION_MAX,
  FOLLOWUP_RATIO_MIN,
  POOL_CONFIDENCE_MAX,
  POOL_EVAL_SCORE_MAX,
  type GapRootCause,
} from "./gap.constants";

/**
 * 入池与根因分诊的纯判定（021 §6.4 / §10，原型 `:371` `:378`）。
 *
 * 全部阈值从 `gap.constants.ts` 取，本文件不出现任何阈值字面量。
 */

/**
 * 「分数偏低」的统一判据。**NULL 不算低** —— 未评不是差评（全局约束 6：绝不落 0 冒充未评）。
 * 这与 ClickHouse 侧 `ifNull(faithfulness, 101)` 哨兵是同一语义，两边必须一致，
 * 否则同一条 trace 在 SQL 预筛和 TS 复判里会给出相反结论。
 */
function isLow(score: number | null, threshold: number): boolean {
  return score !== null && score < threshold;
}

export interface PoolSignals {
  confidence: number | null;
  fallbackUsed: boolean;
  noCitations: boolean;
  faithfulness: number | null;
  answerRelevancy: number | null;
  contextPrecision: number | null;
}

/**
 * 入池判据：四条取**或**（原型 `:378`）。
 * eval 三分只看非空者的最小值——三分里任一低于线即入池，但全空时不入池。
 */
export function shouldEnterPool(s: PoolSignals): boolean {
  if (isLow(s.confidence, POOL_CONFIDENCE_MAX)) return true;
  if (s.fallbackUsed) return true;
  if (s.noCitations) return true;
  return [s.faithfulness, s.answerRelevancy, s.contextPrecision].some((v) =>
    isLow(v, POOL_EVAL_SCORE_MAX),
  );
}

/** 尾部标点（中英文句末/停顿符）。只吃尾部，句中标点是语义的一部分，不能动。 */
const TRAILING_PUNCTUATION = /[\s？?。.！!，,；;、：:…~～]+$/u;

/**
 * 归一化问题文本，供**实质相等**比较（不是给人看的展示形态）。
 * 改写模型经常只把「还有那个点呢」加个问号原样吐回来——只要不归一化，这种「没改写」
 * 会被逐字符比较判成「改写了」，缺口 23 的指代追问就漏检了。
 */
export function normalizeQuestion(q: string): string {
  return q.trim().replace(/\s+/gu, " ").replace(TRAILING_PUNCTUATION, "");
}

/**
 * 改写是否真的解析掉了指代（决策 G）。
 *
 * 首轮恒真：会话第一句没有上文可指代，「改写没变」是正常的，不该被当成失败信号。
 * 非首轮：改写缺失，或归一化后与原问一字不差 ⇒ 未解析。
 */
export function isRewriteResolved(s: {
  isFirstTurnInSession: boolean;
  raw: string;
  rewritten: string | null;
}): boolean {
  if (s.isFirstTurnInSession) return true;
  if (s.rewritten === null) return false;
  return normalizeQuestion(s.rewritten) !== normalizeQuestion(s.raw);
}

/**
 * 归簇用的文本键：优先改写后问题。原问带指代（「那个呢」）时彼此文本高度相似却语义无关，
 * 拿它归簇会把不相干的追问糊成一个大簇。
 */
export function clusterKeyOf(item: { question: string; rewrittenQuestion: string | null }): string {
  return item.rewrittenQuestion ?? item.question;
}

/**
 * 指代追问检测（缺口 23，决策 E）：改写未解析 **且** 精确率近乎零。
 *
 * 必须取合取：只看「改写未变」会误伤本就无需改写的独立提问；只看「精确率≈0」会把真正的
 * 知识缺口也算进来。精确率为 NULL（未评）时不判——没有证据不等于有反证。
 */
export function detectFollowUp(s: {
  rewriteResolved: boolean;
  contextPrecision: number | null;
}): boolean {
  return (
    !s.rewriteResolved &&
    s.contextPrecision !== null &&
    s.contextPrecision <= FOLLOWUP_PRECISION_MAX
  );
}

export interface TriageSignals {
  confidence: number | null;
  contextPrecision: number | null;
  faithfulness: number | null;
}

/** 严重度序（高→低），用于簇级众数平票时确定性取高档。 */
const SEVERITY_ORDER: readonly GapRootCause[] = ["missing", "retrieval", "generation"];

/**
 * 单条根因分诊（原型 `:371`）：
 * - 可信度低 + 精确率低 ⇒ 知识库里根本没有 → `missing`
 * - 精确率低但可信度不低 ⇒ 有内容没召回来 → `retrieval`
 * - 精确率高但忠实度低 ⇒ 召回对了但答歪了 → `generation`
 *
 * 兜底 `missing`：都不匹配意味着信号不足以定责（常见于三分全 NULL 的未评 trace），
 * 归到最严重档等人来看，UI 上该 tag 走「待人工分诊」样式。宁可多叫人看，不可自动放过。
 */
export function triageItem(s: TriageSignals): GapRootCause {
  const lowConfidence = isLow(s.confidence, POOL_CONFIDENCE_MAX);
  const lowPrecision = isLow(s.contextPrecision, POOL_EVAL_SCORE_MAX);
  if (lowPrecision) return lowConfidence ? "missing" : "retrieval";
  if (s.contextPrecision !== null && isLow(s.faithfulness, POOL_EVAL_SCORE_MAX))
    return "generation";
  return "missing";
}

/**
 * 簇级根因：成员判定取众数，平票按严重度取高档（保证同一批输入永远给同一答案）。
 *
 * 随后若 `followUpRatio` **严格大于** `FOLLOWUP_RATIO_MIN`，强制改判 `retrieval`：
 * 一个多半由指代追问构成的簇，低精确率来自改写没解析、不是知识缺口，若判 `missing`
 * 会把人力引去补一篇根本不缺的文档（021 §6.4 的结构性免疫）。
 *
 * 覆写放在众数**之后**，是这条免疫成立的关键——只要触发，输出必不为 `missing`。
 */
export function triageCluster(items: GapRootCause[], followUpRatio: number): GapRootCause {
  const counts = new Map<GapRootCause, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  let best: GapRootCause = "missing";
  let bestCount = 0;
  // 按严重度序遍历 ⇒ 平票时先到者（更严重者）胜出，与 Map 插入顺序无关。
  for (const cause of SEVERITY_ORDER) {
    const count = counts.get(cause) ?? 0;
    if (count > bestCount) {
      best = cause;
      bestCount = count;
    }
  }
  return followUpRatio > FOLLOWUP_RATIO_MIN ? "retrieval" : best;
}
