import { Module } from "@nestjs/common";
import { ModelsModule } from "../models/models.module";
import { ModelsService } from "../models/models.service";
import { DocumentsRepository } from "../documents/documents.repository";
import { KnowledgeBasesRepository } from "../knowledge-bases/knowledge-bases.repository";
import { ChunksRepository } from "../chunks/chunks.repository";
import { AppConfigService } from "../../platform/config/config.service";
import { QueueModule } from "../../platform/queue/queue.module";
import { StorageModule } from "../../platform/storage/storage.module";
import { IngestionService, DOCUMENT_TERMINAL_LISTENER } from "./ingestion.service";
import { IngestionProcessor } from "./ingestion.processor";
import { KbRebuildService } from "./kb-rebuild.service";
import { DefaultIngestionPipeline } from "./default-ingestion-pipeline";
import { INGESTION_PIPELINE_PORT } from "./ingestion.constants";

// 依赖装配说明：
// - QueueModule / StorageModule 是 @Global 但此前无消费方、未被任何模块 import（token 尚未注册）；
//   本模块是 INGESTION_QUEUE / BLOB_STORE 的首个消费方，在此 import 一次即全局生效。
// - DRIZZLE（PersistenceModule）/ AppConfigService（AppConfigModule）已由 AppModule import 的 @Global 模块提供。
// - Repository 只依赖 DRIZZLE，这里直接 provide，不 import DocumentsModule/KnowledgeBasesModule/ChunksModule
//   整个业务模块——避免 T19 DocumentsModule 反向 import IngestionModule（enqueue）时的循环依赖。
// - ModelsService 只能经 ModelsModule 导出的端口拿到，故 import ModelsModule。
@Module({
  imports: [ModelsModule, QueueModule, StorageModule],
  providers: [
    IngestionService,
    IngestionProcessor,
    KbRebuildService,
    // 用 useExisting 把重建服务绑到终态监听 token；IngestionService 经 ModuleRef 懒解析此 token，
    // 不构造期依赖，避免与 KbRebuildService（构造依赖 IngestionService.enqueue）的循环。
    { provide: DOCUMENT_TERMINAL_LISTENER, useExisting: KbRebuildService },
    DocumentsRepository,
    KnowledgeBasesRepository,
    ChunksRepository,
    {
      provide: INGESTION_PIPELINE_PORT,
      inject: [ModelsService, ChunksRepository, AppConfigService],
      useFactory: (models: ModelsService, chunksRepo: ChunksRepository, config: AppConfigService) =>
        new DefaultIngestionPipeline(models, chunksRepo, config.ingestionEmbedBatchSize),
    },
  ],
  // KbRebuildService 导出供 Task 18 KnowledgeBasesService.update 改 chunkTemplate 时调用 startRebuild。
  exports: [IngestionService, KbRebuildService],
})
export class IngestionModule {}
