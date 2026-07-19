import { Global, Inject, Module, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
// pg-boss v12 是纯 ESM 包、无 default export，只有 named export `PgBoss`——见 pg-boss-queue.adapter.ts 顶部注释。
import { PgBoss } from "pg-boss";
import { AppConfigService } from "../config/config.service";
import { PgBossQueueAdapter } from "./pg-boss-queue.adapter";
import { RoleGatedQueueAdapter } from "./role-gated-queue.adapter";
import {
  EVAL_RUN_QUEUE,
  EVALUATION_QUEUE,
  INGESTION_QUEUE,
  MANUAL_SCORE_QUEUE,
  QUEUE_CONSUMER_ROLES,
  RELEASE_CHECK_QUEUE,
} from "./queue.constants";

// module-private token：只用来把 PgBoss 实例接到生命周期钩子和适配器工厂上，不导出——
// 消费方只能拿到 INGESTION_QUEUE 这个端口，拿不到 PgBoss 实例本身。
const PG_BOSS_INSTANCE = Symbol("PG_BOSS_INSTANCE");

// 019 D1：消费门控在 token 工厂处收口——processor 拿到的 Queue 实例已按角色裁剪，
// subscribe/schedule 对非本角色队列 no-op，publish 恒透传（Boundary 3）。
function gatedQueue(
  boss: PgBoss,
  config: AppConfigService,
  key: keyof typeof QUEUE_CONSUMER_ROLES,
): RoleGatedQueueAdapter {
  const consumeEnabled = (QUEUE_CONSUMER_ROLES[key] as readonly string[]).includes(
    config.processRole,
  );
  return new RoleGatedQueueAdapter(new PgBossQueueAdapter(boss), consumeEnabled, key);
}

@Global()
@Module({
  providers: [
    {
      provide: PG_BOSS_INSTANCE,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => new PgBoss(config.databaseUrl),
    },
    {
      provide: INGESTION_QUEUE,
      inject: [PG_BOSS_INSTANCE, AppConfigService],
      useFactory: (boss: PgBoss, config: AppConfigService) => gatedQueue(boss, config, "ingestion"),
    },
    {
      // M7b：release-check 用第二个 adapter 实例（各自 ensuredQueues 缓存，createQueue 幂等，多实例无害）
      provide: RELEASE_CHECK_QUEUE,
      inject: [PG_BOSS_INSTANCE, AppConfigService],
      useFactory: (boss: PgBoss, config: AppConfigService) =>
        gatedQueue(boss, config, "releaseCheck"),
    },
    {
      provide: EVALUATION_QUEUE,
      inject: [PG_BOSS_INSTANCE, AppConfigService],
      useFactory: (boss: PgBoss, config: AppConfigService) =>
        gatedQueue(boss, config, "evaluation"),
    },
    {
      // B1/F3：人工「立即评测」队列。api 角色（同 releaseCheck），不与 evaluation 共用 token。
      provide: MANUAL_SCORE_QUEUE,
      inject: [PG_BOSS_INSTANCE, AppConfigService],
      useFactory: (boss: PgBoss, config: AppConfigService) =>
        gatedQueue(boss, config, "manualScore"),
    },
    {
      // E-W2a：离线 run 队列（018 决策 A）。同 release-check/evaluation，各自一个 adapter 实例。
      provide: EVAL_RUN_QUEUE,
      inject: [PG_BOSS_INSTANCE, AppConfigService],
      useFactory: (boss: PgBoss, config: AppConfigService) => gatedQueue(boss, config, "evalRun"),
    },
  ],
  exports: [
    INGESTION_QUEUE,
    RELEASE_CHECK_QUEUE,
    EVALUATION_QUEUE,
    MANUAL_SCORE_QUEUE,
    EVAL_RUN_QUEUE,
  ],
})
export class QueueModule implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(PG_BOSS_INSTANCE) private readonly boss: PgBoss) {}

  async onModuleInit(): Promise<void> {
    await this.boss.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss.stop();
  }
}
