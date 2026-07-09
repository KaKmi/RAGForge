import { PgBossQueueAdapter } from "../src/platform/queue/pg-boss-queue.adapter";

// 模拟 pg-boss v12 真实行为：队列不存在时 send/work 抛
// `Queue <name> does not exist`（manager.js getQueueCache），必须先 createQueue。
// 这样不调 createQueue 直接 send/work 的实现在这些测试下必然失败。
function makeFakeBoss() {
  const createdQueues = new Set<string>();
  return {
    createQueue: jest.fn(async (name: string) => {
      // 与真实实现一致：INSERT ... ON CONFLICT DO NOTHING，幂等
      createdQueues.add(name);
    }),
    send: jest.fn(async (name: string) => {
      if (!createdQueues.has(name)) {
        throw new Error(`Queue ${name} does not exist`);
      }
      return "job-id-1";
    }),
    work: jest.fn(async (name: string) => {
      if (!createdQueues.has(name)) {
        throw new Error(`Queue ${name} does not exist`);
      }
      return undefined;
    }),
    start: jest.fn(async () => undefined),
    stop: jest.fn(async () => undefined),
  };
}

describe("PgBossQueueAdapter", () => {
  it("publish：先 createQueue 再 send，并把 singletonKey/retryLimit 映射为 pg-boss send options", async () => {
    const boss = makeFakeBoss();
    const adapter = new PgBossQueueAdapter(boss as never);
    await adapter.publish(
      "ingest-document",
      { documentId: "d1" },
      {
        singletonKey: "d1",
        retryLimit: 1,
      },
    );
    expect(boss.createQueue).toHaveBeenCalledWith("ingest-document");
    expect(boss.send).toHaveBeenCalledWith(
      "ingest-document",
      { documentId: "d1" },
      expect.objectContaining({ singletonKey: "d1", retryLimit: 1 }),
    );
  });

  it("subscribe：先 createQueue 再注册 handler，并在收到 job 时以 job.data 调用", async () => {
    const boss = makeFakeBoss();
    const adapter = new PgBossQueueAdapter(boss as never);
    const handler = jest.fn(async () => undefined);
    await adapter.subscribe("ingest-document", handler);
    expect(boss.createQueue).toHaveBeenCalledWith("ingest-document");
    expect(boss.work).toHaveBeenCalledWith("ingest-document", expect.any(Function));
    // 模拟 pg-boss 调用 work 注册的回调
    const registeredCallback = boss.work.mock.calls[0][1] as (
      jobs: Array<{ data: unknown }>,
    ) => Promise<void>;
    await registeredCallback([{ data: { documentId: "d1" } }]);
    expect(handler).toHaveBeenCalledWith({ documentId: "d1" });
  });

  it("重复 publish 同一队列名：createQueue 只调用一次（含并发首次调用）", async () => {
    const boss = makeFakeBoss();
    const adapter = new PgBossQueueAdapter(boss as never);
    await Promise.all([
      adapter.publish("ingest-document", { documentId: "d1" }),
      adapter.publish("ingest-document", { documentId: "d2" }),
    ]);
    await adapter.publish("ingest-document", { documentId: "d3" });
    expect(boss.createQueue).toHaveBeenCalledTimes(1);
    expect(boss.send).toHaveBeenCalledTimes(3);
  });

  it("createQueue 失败：publish 透传错误，且下次 publish 会重试 createQueue", async () => {
    const boss = makeFakeBoss();
    boss.createQueue.mockRejectedValueOnce(new Error("db down"));
    const adapter = new PgBossQueueAdapter(boss as never);
    await expect(adapter.publish("ingest-document", { documentId: "d1" })).rejects.toThrow(
      "db down",
    );
    expect(boss.send).not.toHaveBeenCalled();
    // ensure 缓存已因失败清除，下次 publish 重试 createQueue 并成功
    await adapter.publish("ingest-document", { documentId: "d1" });
    expect(boss.createQueue).toHaveBeenCalledTimes(2);
    expect(boss.send).toHaveBeenCalledTimes(1);
  });
});
