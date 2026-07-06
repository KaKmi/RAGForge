import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";
import { ZodSerializerInterceptor, ZodValidationPipe } from "nestjs-zod";
import { AppConfigModule } from "./platform/config/config.module";
import { PersistenceModule } from "./platform/persistence/persistence.module";
import { ClickHouseModule } from "./platform/clickhouse/clickhouse.module";
import { HealthModule } from "./modules/health/health.module";
import { TracesModule } from "./modules/traces/traces.module";
import { UsersModule } from "./modules/users/users.module";
import { AuthModule } from "./modules/auth/auth.module";

@Module({
  imports: [
    AppConfigModule,
    PersistenceModule,
    ClickHouseModule,
    HealthModule,
    TracesModule,
    UsersModule,
    AuthModule,
  ],
  providers: [
    // 全局 Zod 管道：@Body/@Query/@Param 用 createZodDto 时自动校验，失败抛 ZodValidationException(400)
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    // 全局响应序列化拦截器：仅在 handler 标注 @ZodResponse/@ZodSerializerDto 时生效，未标注则透传
    { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
  ],
})
export class AppModule {}
