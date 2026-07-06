import type { ChatCitation, Conversation, Message } from "@codecrush/contracts";

/** M2 mock：C 端问答页用。M8 接真实 /api/chat SSE 流。 */

export const MOCK_CONVERSATIONS: Conversation[] = [
  {
    id: "c1",
    agentId: "aftersale",
    userId: "u1",
    title: "退货流程咨询",
    updatedAt: "2026-07-06T09:00:00Z",
  },
  {
    id: "c2",
    agentId: "aftersale",
    userId: "u1",
    title: "保修期查询",
    updatedAt: "2026-07-06T10:30:00Z",
  },
  {
    id: "c3",
    agentId: "aftersale",
    userId: "u1",
    title: "物流时效",
    updatedAt: "2026-07-06T11:15:00Z",
  },
];

export const MOCK_CITATIONS: ChatCitation[] = [
  { n: 1, doc: "退换货政策.pdf", kb: "售后服务知识库", section: "第一节", score: 0.92 },
  { n: 2, doc: "保修条款.docx", kb: "售后服务知识库", section: "第二节", score: 0.85 },
];

export const MOCK_MESSAGES: Message[] = [
  {
    id: "msg1",
    convId: "c1",
    role: "user",
    content: "退货流程怎么走？",
  },
  {
    id: "msg2",
    convId: "c1",
    role: "assistant",
    content:
      "您可以在签收 7 日内通过「我的订单」申请退货 [1]，审核通过后寄回商品即可。保修期内非人为损坏可免费维修 [2]。",
    traceId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    confidence: 0.88,
    citations: ["1", "2"],
  },
];
