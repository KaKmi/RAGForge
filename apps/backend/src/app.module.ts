import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";
import { ZodSerializerInterceptor, ZodValidationPipe } from "nestjs-zod";
import { AppConfigModule } from "./platform/config/config.module";
import { PersistenceModule } from "./platform/persistence/persistence.module";
import { ClickHouseModule } from "./platform/clickhouse/clickhouse.module";
import { SecurityModule } from "./platform/security/security.module";
import { StorageModule } from "./platform/storage/storage.module";
import { QueueModule } from "./platform/queue/queue.module";
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
import { ApplicationsModule } from "./modules/applications/applications.module";

@Module({
  imports: [
    AppConfigModule,
    PersistenceModule,
    ClickHouseModule,
    SecurityModule,
    StorageModule,
    QueueModule,
    HealthModule,
    TracesModule,
    UsersModule,
    AuthModule,
    ModelsModule,
    // M4 真实实现：知识库/文档/切片/入库管线（持久化 + BlobStore + pg-boss 异步四阶段管线）
    KnowledgeBasesModule,
    DocumentsModule,
    IngestionModule,
    ChunksModule,
    RetrievalModule,
    AgentsModule,
    PromptsModule,
    ApplicationsModule,
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
