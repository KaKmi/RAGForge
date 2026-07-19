/**
 * 缺口聚类的纯向量运算（021 §10 / 决策 C）。
 *
 * 单独成文件、零依赖：收集器 worker 是唯一调用方，但这些函数的正确性（尤其零向量与
 * 增量质心和批量均值的一致性）值得表驱动单测独立覆盖，不该埋在 service 里靠集成测试撞。
 */

/**
 * 余弦相似度。零向量/空向量/维度不一致一律返回 0 —— 返回 NaN 会让上游
 * `sim >= CLUSTER_SIMILARITY_MIN` 静默判 false 而不报错，等于把脏数据伪装成「不相似」；
 * 显式取 0 语义相同但可解释（"没有可比信息" ⇒ 不归簇 ⇒ 建新簇）。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 增量更新簇质心：`(centroid * freq + v) / (freq + 1)`。
 *
 * 用增量而非「取回全部成员向量重算」，是因为收集器每次只处理增量 trace，簇成员向量并不
 * 全在手上（ClickHouse 里存的是 item，重拉一簇的全部 embedding 代价随簇规模线性增长）。
 * `freq` 必须是**并入本向量之前**的成员数，否则权重会偏。返回新数组，不改入参。
 */
export function updateCentroid(centroid: number[], freq: number, v: number[]): number[] {
  if (freq <= 0) return [...v];
  return centroid.map((c, i) => (c * freq + v[i]) / (freq + 1));
}

/**
 * 批量均值。簇被人工拆分后成员集合整体变了，增量式无法回退，只能拿剩余成员重算。
 * 与 `updateCentroid` 逐个并入的结果在浮点误差内一致（有测试守着这条不变量）。
 */
export function meanVector(vs: number[][]): number[] {
  if (vs.length === 0) return [];
  const dim = vs[0].length;
  const out = new Array<number>(dim).fill(0);
  for (const v of vs) {
    for (let i = 0; i < dim; i++) out[i] += v[i];
  }
  return out.map((s) => s / vs.length);
}
