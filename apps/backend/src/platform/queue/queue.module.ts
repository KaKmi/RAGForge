import {
  Global,
  Inject,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
// pg-boss v12 是纯 ESM 包、无 default export，只有 named export `PgBoss`——见 pg-boss-queue.adapter.ts 顶部注释。
import { PgBoss } from "pg-boss";
import { AppConfigService } from "../config/config.service";
import { PgBossQueueAdapter } from "./pg-boss-queue.adapter";
import { INGESTION_QUEUE } from "./queue.constants";

// module-private token：只用来把 PgBoss 实例接到生命周期钩子和适配器工厂上，不导出——
// 消费方只能拿到 INGESTION_QUEUE 这个端口，拿不到 PgBoss 实例本身。
const PG_BOSS_INSTANCE = Symbol("PG_BOSS_INSTANCE");

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
      inject: [PG_BOSS_INSTANCE],
      useFactory: (boss: PgBoss) => new PgBossQueueAdapter(boss),
    },
  ],
  exports: [INGESTION_QUEUE],
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
