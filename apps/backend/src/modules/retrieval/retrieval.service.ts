import { Injectable } from "@nestjs/common";
import type { RetrievalTestRequest, RetrievalTestResponse } from "@codecrush/contracts";

@Injectable()
export class RetrievalService {
  /**
   * M2 桩：返回一条 mock 命中。M5 接真实检索（向量 + 关键词 + 重排）。
   */
  test(_req: RetrievalTestRequest): RetrievalTestResponse {
    return {
      hits: [
        {
          chunkId: "c1",
          docId: "d1",
          docName: "退换货政策.pdf",
          text: "7天无理由退货需保留商品完好...",
          section: "退货条件",
          vecScore: 0.82,
          kwScore: 0.6,
          rerankScore: 0.88,
          finalScore: 0.85,
        },
      ],
    };
  }
}
