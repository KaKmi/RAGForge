import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";
import { ZodSerializerInterceptor, ZodValidationPipe } from "nestjs-zod";
import { AppConfigModule } from "./platform/config/config.module";
import { PersistenceModule } from "./platform/persistence/persistence.module";
import { ClickHouseModule } from "./platform/clickhouse/clickhouse.module";
import { SecurityModule } from "./platform/security/security.module";
import { HealthModule } from "./modules/health/health.module";
import { TracesModule } from "./modules/traces/traces.module";
import { UsersModule } from "./modules/users/users.module";
import { AuthModule } from "./modules/auth/auth.module";
import { ModelsModule } from "./modules/models/models.module";
import { KnowledgeBasesModule } from "./modules/knowledge-bases/knowledge-bases.module";
import { DocumentsModule } from "./modules/documents/documents.module";
import { IngestionModule } from "./modules/ingestion/ingestion.module";
import { ChunksModule } from "./modules/chunks/chunks.module";
import { RetrievalModule } from "./modules/retrieval/retrieval.module";
import { AgentsModule } from "./modules/agents/agents.module";
import { PromptsModule } from "./modules/prompts/prompts.module";
import { ChatModule } from "./modules/chat/chat.module";
import { ConversationsModule } from "./modules/conversations/conversations.module";

@Module({
  imports: [
    AppConfigModule,
    PersistenceModule,
    ClickHouseModule,
    SecurityModule,
    HealthModule,
    TracesModule,
    UsersModule,
    AuthModule,
    // M2 域骨架（10 个）：mock/空态，无持久化；M3+ 按里程碑填真实逻辑
    ModelsModule,
    KnowledgeBasesModule,
    DocumentsModule,
    IngestionModule,
    ChunksModule,
    RetrievalModule,
    AgentsModule,
    PromptsModule,
    ChatModule,
    ConversationsModule,
  ],
  providers: [
    // 全局 Zod 管道：@Body/@Query/@Param 用 createZodDto 时自动校验，失败抛 ZodValidationException(400)
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    // 全局响应序列化拦截器：仅在 handler 标注 @ZodResponse/@ZodSerializerDto 时生效，未标注则透传
    { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
  ],
})
export class AppModule {}
