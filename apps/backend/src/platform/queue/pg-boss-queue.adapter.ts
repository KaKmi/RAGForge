import { Injectable } from "@nestjs/common";
// pg-boss v12 是纯 ESM 包且不带 default export（仅 named export `PgBoss`）——
// 实测 `import PgBoss from "pg-boss"` 在本仓库 CommonJS 编译下会拿到 undefined，
// 故此处用 named type-only import，偏离 brief 里的默认导入写法。
import type { PgBoss } from "pg-boss";
import type { JobOptions, Queue } from "./queue.port";

@Injectable()
export class PgBossQueueAdapter implements Queue {
  // pg-boss v12 要求 send/work 前队列必须已存在（manager.js getQueueCache 否则抛
  // `Queue <name> does not exist`）。createQueue 底层 INSERT ... ON CONFLICT DO NOTHING，
  // 幂等可重复调用；这里按 name 缓存 in-flight Promise，每个队列名只 create 一次，
  // 并发首次调用也只发一条 SQL。失败时清缓存以便下次重试。队列创建是适配器内部关切，不进端口。
  private readonly ensuredQueues = new Map<string, Promise<void>>();

  constructor(private readonly boss: PgBoss) {}

  private ensureQueue(jobName: string): Promise<void> {
    let ensured = this.ensuredQueues.get(jobName);
    if (!ensured) {
      ensured = this.boss.createQueue(jobName).catch((error: unknown) => {
        this.ensuredQueues.delete(jobName);
        throw error;
      });
      this.ensuredQueues.set(jobName, ensured);
    }
    return ensured;
  }

  async publish(jobName: string, data: unknown, opts: JobOptions = {}): Promise<void> {
    await this.ensureQueue(jobName);
    await this.boss.send(jobName, data as object, {
      singletonKey: opts.singletonKey,
      retryLimit: opts.retryLimit ?? 0,
    });
  }

  async subscribe(jobName: string, handler: (data: unknown) => Promise<void>): Promise<void> {
    await this.ensureQueue(jobName);
    await this.boss.work(jobName, async (jobs: Array<{ data: unknown }>) => {
      for (const job of jobs) {
        await handler(job.data);
      }
    });
  }
}
