import type { RetrievalHit } from "@codecrush/contracts";

/** M2 mock：检索测试页用。M5 接真实 /api/retrieval/test。 */

export const MOCK_RETRIEVAL_HITS: RetrievalHit[] = [
  {
    chunkId: "chunk1",
    docId: "doc1",
    docName: "退换货政策.pdf",
    text: "7 天无理由退货：自签收之日起 7 日内，商品未经使用、不影响二次销售的，可申请无理由退货。",
    section: "第一节",
    vecScore: 0.92,
    kwScore: 0.78,
    rerankScore: 0.89,
    finalScore: 0.89,
  },
  {
    chunkId: "chunk2",
    docId: "doc1",
    docName: "退换货政策.pdf",
    text: "保修期：主机 12 个月，配件 6 个月，自购买凭证日期起计算。",
    section: "第二节",
    vecScore: 0.85,
    kwScore: 0.72,
    rerankScore: 0.81,
    finalScore: 0.81,
  },
  {
    chunkId: "chunk3",
    docId: "doc1",
    docName: "退换货政策.pdf",
    text: "物流时效：顺丰 1-3 天，圆通 3-5 天，偏远地区另计。",
    section: "第三节",
    vecScore: 0.71,
    kwScore: 0.65,
    rerankScore: 0.6,
    finalScore: 0.6,
  },
];
