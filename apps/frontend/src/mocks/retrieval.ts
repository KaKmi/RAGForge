/** M2 mock：检索测试页配置项 + 结果计算。M5 接真实 /api/retrieval/test。 */

export const RT_KBS = ["课程目录库", "售后服务知识库", "学习指南库", "订单FAQ"];
export const RT_EMBEDS = ["bge-m3 (1024 维)", "text-embedding-3-large"];
export const RT_RERANKS = ["bge-reranker-v2-m3", "Jina Reranker v2", "不启用重排"];

export interface RtResult {
  rank: number;
  hybrid: string;
  kw: string;
  vec: string;
  source: string;
  text: string;
}

export interface RtCite {
  doc: string;
  sec: string;
  text: string;
  kb: string;
  score: string;
}

/**
 * 由 CITES + 参数动态计算召回结果（对齐原型 rtPool/rtResults 逻辑）。
 * 向量分取 cite.score，关键词分近似推导，混合分 = vec*权重 + kw*(1-权重)。
 */
export function computeRtResults(
  cites: RtCite[],
  opts: { vec: number; threshold: number; multi: boolean }
): RtResult[] {
  const vec = opts.vec;
  const full = +(1 - vec).toFixed(2);
  const pool = cites.map((c, i) => {
    const v = parseFloat(c.score);
    const kw = Math.max(0, Math.min(1, v - 0.06 - (i % 3) * 0.05));
    const hybrid = +(v * vec + kw * full).toFixed(4);
    return { doc: c.doc, sec: c.sec, text: c.text, kb: c.kb, vecN: v, kwN: kw, hybridN: hybrid };
  });
  return pool
    .filter(r => (opts.multi ? r.hybridN : r.vecN) >= opts.threshold)
    .sort((a, b) => (opts.multi ? b.hybridN - a.hybridN : b.vecN - a.vecN))
    .map((r, i) => ({
      rank: i + 1,
      hybrid: (opts.multi ? r.hybridN * 100 : r.vecN * 100).toFixed(2),
      kw: (r.kwN * 100).toFixed(2),
      vec: (r.vecN * 100).toFixed(2),
      source: `${r.kb} · ${r.sec}`,
      text: r.text,
    }));
}
