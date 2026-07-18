import type { RetrievalHit, RetrievalTestRequest } from "@codecrush/contracts";

// 001「RetrieverPort.retrieve(query, opts)」的落地：复用 RetrievalTestRequest 作为单一入参
// （query 已内嵌在其中），避免与该 DTO 近乎重复定义第二个类型——chat（M8）与检索测试台
// 共用同一个端口/同一个入参形状，不是两套实现。
export interface RetrieverPort {
  retrieve(
    req: RetrievalTestRequest,
    observer?: (signal: "keyword_degraded" | "rerank_degraded") => void,
    /** E-W2b F1：外部中止信号，透传给 embed/rerank（加性可选，省略 → 行为不变）。 */
    signal?: AbortSignal,
  ): Promise<RetrievalHit[]>;
}
