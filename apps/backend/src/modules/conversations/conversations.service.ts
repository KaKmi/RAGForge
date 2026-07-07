import { Injectable, NotFoundException } from "@nestjs/common";
import type { Conversation, Message } from "@codecrush/contracts";

const MOCK_CONVS: Conversation[] = [
  {
    id: "c1",
    agentId: "aftersale",
    userId: "u1",
    title: "退货咨询",
    updatedAt: "2026-06-30T10:00:00.000Z",
  },
  {
    id: "c2",
    agentId: "aftersale",
    userId: "u1",
    title: "换货流程",
    updatedAt: "2026-06-30T11:00:00.000Z",
  },
];

const MOCK_MSGS: Message[] = [
  {
    id: "m1",
    convId: "c1",
    role: "user",
    content: "怎么退货？",
  },
  {
    id: "m2",
    convId: "c1",
    role: "assistant",
    content: "请提供订单号，我帮您查询退货流程。",
    traceId: "391dae938234560b16bb63f51501cb6f",
    confidence: 0.82,
    citations: ["1"],
  },
];

@Injectable()
export class ConversationsService {
  list(): Conversation[] {
    return MOCK_CONVS;
  }

  get(id: string): Conversation {
    const conv = MOCK_CONVS.find((c) => c.id === id);
    if (!conv) throw new NotFoundException(`conversation ${id} not found`);
    return conv;
  }

  listMessages(convId: string): Message[] {
    this.get(convId); // 校验 conversation 存在
    return MOCK_MSGS.filter((m) => m.convId === convId);
  }
}
