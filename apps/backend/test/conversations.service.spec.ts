import { NotFoundException } from "@nestjs/common";
import type { Conversation, Message } from "@codecrush/contracts";
import { ConversationsService } from "../src/modules/conversations/conversations.service";
import type {
  AppendMessageInput,
  ConversationsRepository,
  CreateConversationInput,
} from "../src/modules/conversations/conversations.repository";

// 内存假 repository：验证 service 的委托语义（隔离/roundtrip），不碰真实 DB
// 时钟用单调递增 tick，避免同毫秒内 updatedAt 打平导致排序断言不稳定
function makeFakeRepo() {
  const convs: Conversation[] = [];
  const msgs: Message[] = [];
  let seq = 0;
  let tick = Date.now();
  const nextTime = () => new Date(++tick).toISOString();
  const repo = {
    createConversation: jest.fn(async (input: CreateConversationInput): Promise<Conversation> => {
      const conv: Conversation = {
        id: `conv-${++seq}`,
        agentId: input.agentId,
        userId: input.userId,
        title: input.title,
        updatedAt: nextTime(),
      };
      convs.push(conv);
      return conv;
    }),
    appendMessage: jest.fn(async (input: AppendMessageInput): Promise<Message> => {
      const msg: Message = { id: `msg-${++seq}`, ...input };
      msgs.push(msg);
      // 与真实 repository 对齐：追加消息同时回写父会话 updatedAt（活跃时间）
      const conv = convs.find((c) => c.id === input.convId);
      if (conv) conv.updatedAt = nextTime();
      return msg;
    }),
    list: jest.fn(async (agentId?: string, userId?: string): Promise<Conversation[]> =>
      convs
        .filter((c) => (!agentId || c.agentId === agentId) && (!userId || c.userId === userId))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    ),
    getById: jest.fn(
      async (id: string): Promise<Conversation | undefined> => convs.find((c) => c.id === id),
    ),
    listMessages: jest.fn(
      async (convId: string): Promise<Message[]> => msgs.filter((m) => m.convId === convId),
    ),
  };
  return repo as typeof repo & ConversationsRepository;
}

describe("ConversationsService（真实读写）", () => {
  it("createConversation + appendMessage 后可 list/get/listMessages", async () => {
    const svc = new ConversationsService(makeFakeRepo());
    const conv = await svc.createConversation({ agentId: "app1", userId: "u1", title: "怎么退货" });
    expect(conv.id).toBeTruthy();
    expect(conv.agentId).toBe("app1");

    await svc.appendMessage({ convId: conv.id, role: "user", content: "怎么退货" });
    await svc.appendMessage({
      convId: conv.id,
      role: "assistant",
      content: "见政策[1]",
      traceId: "t".repeat(32),
      confidence: 0.8,
      coverage: "full",
      isFallback: false,
      fallbackInfo: { reasons: [] },
      citations: ["1"],
    });

    expect((await svc.list("app1")).length).toBe(1);
    expect((await svc.get(conv.id)).title).toBe("怎么退货");

    const msgs = await svc.listMessages(conv.id);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1].traceId).toHaveLength(32);
    expect(msgs[1].confidence).toBe(0.8);
    expect(msgs[1].coverage).toBe("full");
    expect(msgs[1].isFallback).toBe(false);
    expect(msgs[1].fallbackInfo).toEqual({ reasons: [] });
    expect(msgs[1].citations).toEqual(["1"]);
  });

  it("list 按 agentId 隔离", async () => {
    const svc = new ConversationsService(makeFakeRepo());
    await svc.createConversation({ agentId: "app1", userId: "u1", title: "app1 的会话" });
    expect(await svc.list("app2")).toEqual([]);
    expect((await svc.list("app1")).length).toBe(1);
  });

  it("M8 T4：list 只返回指定 agentId + userId 的会话", async () => {
    const svc = new ConversationsService(makeFakeRepo());
    await svc.createConversation({ agentId: "app1", userId: "uX", title: "A" });
    await svc.createConversation({ agentId: "app1", userId: "uY", title: "B" });
    await svc.createConversation({ agentId: "app2", userId: "uX", title: "C" });
    const rows = await svc.list("app1", "uX");
    expect(rows.map((r) => r.title)).toEqual(["A"]);
  });

  it("M8 T4：get/listMessages 拒绝非本人会话（IDOR → NotFound）", async () => {
    const svc = new ConversationsService(makeFakeRepo());
    const b = await svc.createConversation({ agentId: "app1", userId: "uY", title: "B" });
    await expect(svc.get(b.id, "uX")).rejects.toThrow(NotFoundException);
    await expect(svc.listMessages(b.id, "uX")).rejects.toThrow(NotFoundException);
  });

  it("appendMessage 回写会话活跃时间：先建 A 再建 B，向 A 追加消息后 list 中 A 排最前", async () => {
    const svc = new ConversationsService(makeFakeRepo());
    const a = await svc.createConversation({ agentId: "app1", userId: "u1", title: "会话 A" });
    const b = await svc.createConversation({ agentId: "app1", userId: "u1", title: "会话 B" });

    await svc.appendMessage({ convId: a.id, role: "user", content: "新消息" });

    const listed = await svc.list("app1");
    expect(listed.map((c) => c.id)).toEqual([a.id, b.id]);
  });

  it("get 不存在时抛 NotFound（保留 M2 HTTP 语义）", async () => {
    const svc = new ConversationsService(makeFakeRepo());
    await expect(svc.get("missing")).rejects.toThrow(NotFoundException);
  });

  it("listMessages 校验会话存在，不存在抛 NotFound", async () => {
    const svc = new ConversationsService(makeFakeRepo());
    await expect(svc.listMessages("missing")).rejects.toThrow(NotFoundException);
  });
});
