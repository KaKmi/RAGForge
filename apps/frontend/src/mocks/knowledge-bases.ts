import type { Chunk, Document, KnowledgeBase } from "@codecrush/contracts";

/** M2 mock：知识库管理 / 文档 / 切片页用。M4 接真实 /api/knowledge-bases 等。 */

export const MOCK_KNOWLEDGE_BASES: KnowledgeBase[] = [
  {
    id: "kb1",
    name: "售后服务知识库",
    desc: "退换货、保修、物流政策",
    embeddingModelId: "m3",
    docsCount: 12,
    chunksCount: 3412,
    status: "ready",
    updatedAt: "2026-07-01T10:00:00Z",
  },
  {
    id: "kb2",
    name: "产品手册知识库",
    desc: "产品规格、使用说明",
    embeddingModelId: "m3",
    docsCount: 8,
    chunksCount: 2104,
    status: "building",
    progress: 65,
    updatedAt: "2026-07-03T08:30:00Z",
  },
  {
    id: "kb3",
    name: "FAQ 知识库",
    desc: "高频问题",
    embeddingModelId: "m3",
    docsCount: 5,
    chunksCount: 860,
    status: "failed",
    updatedAt: "2026-07-05T14:20:00Z",
  },
];

export const MOCK_DOCUMENTS: Document[] = [
  {
    id: "doc1",
    kbId: "kb1",
    name: "退换货政策.pdf",
    type: "pdf",
    size: 248320,
    chunksCount: 86,
    status: "ready",
    updatedAt: "2026-07-01T10:00:00Z",
  },
  {
    id: "doc2",
    kbId: "kb1",
    name: "保修条款.docx",
    type: "word",
    size: 102400,
    chunksCount: 42,
    status: "ingest",
    stage: "向量化中",
    updatedAt: "2026-07-05T09:10:00Z",
  },
  {
    id: "doc3",
    kbId: "kb1",
    name: "物流时效说明.md",
    type: "markdown",
    size: 8192,
    chunksCount: 0,
    status: "failed",
    error: "切片失败：编码不支持",
    updatedAt: "2026-07-05T14:20:00Z",
  },
];

export const MOCK_CHUNKS: Chunk[] = [
  {
    id: "chunk1",
    docId: "doc1",
    kbId: "kb1",
    seq: 1,
    text: "7 天无理由退货：自签收之日起 7 日内，商品未经使用、不影响二次销售的，可申请无理由退货。",
    tokenCount: 38,
    section: "退换货政策 / 第一节",
    enabled: true,
  },
  {
    id: "chunk2",
    docId: "doc1",
    kbId: "kb1",
    seq: 2,
    text: "保修期：主机 12 个月，配件 6 个月，自购买凭证日期起计算。",
    tokenCount: 26,
    section: "退换货政策 / 第二节",
    enabled: true,
  },
  {
    id: "chunk3",
    docId: "doc1",
    kbId: "kb1",
    seq: 3,
    text: "物流时效：顺丰 1-3 天，圆通 3-5 天，偏远地区另计。",
    tokenCount: 22,
    section: "退换货政策 / 第三节",
    enabled: false,
  },
];
