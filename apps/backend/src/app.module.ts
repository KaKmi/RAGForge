import { Module } from "@nestjs/common";
import { AppConfigModule } from "./platform/config/config.module";
import { PersistenceModule } from "./platform/persistence/persistence.module";
import { ClickHouseModule } from "./platform/clickhouse/clickhouse.module";
import { HealthModule } from "./modules/health/health.module";
import { TracesModule } from "./modules/traces/traces.module";
import { UsersModule } from "./modules/users/users.module";

@Module({
  imports: [
    AppConfigModule,
    PersistenceModule,
    ClickHouseModule,
    HealthModule,
    TracesModule,
    UsersModule,
  ],
})
export class AppModule {}
