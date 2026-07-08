import { forwardRef, Module } from "@nestjs/common";
import { DocumentsController } from "./documents.controller";
import { DocumentsRepository } from "./documents.repository";
import { DocumentsService } from "./documents.service";
import { ChunksRepository } from "../chunks/chunks.repository";
import { KnowledgeBasesModule } from "../knowledge-bases/knowledge-bases.module";
import { IngestionModule } from "../ingestion/ingestion.module";

// KnowledgeBasesModule/IngestionModule 都可能反向引用本模块（三表紧耦合的入库域），
// 用 forwardRef 打破 Nest 模块图上的循环 import。
@Module({
  imports: [forwardRef(() => KnowledgeBasesModule), forwardRef(() => IngestionModule)],
  controllers: [DocumentsController],
  // ChunksRepository 只依赖全局 DRIZZLE，直接 provide：ChunksModule imports 本模块，
  // 反向 import ChunksModule 会成环。
  providers: [DocumentsRepository, ChunksRepository, DocumentsService],
  exports: [DocumentsRepository, DocumentsService],
})
export class DocumentsModule {}
