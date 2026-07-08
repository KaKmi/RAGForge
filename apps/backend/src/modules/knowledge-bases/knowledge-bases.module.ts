import { Module } from "@nestjs/common";
import { KnowledgeBasesController } from "./knowledge-bases.controller";
import { KnowledgeBasesRepository } from "./knowledge-bases.repository";
import { KnowledgeBasesService } from "./knowledge-bases.service";
import { ModelsModule } from "../models/models.module";
import { IngestionModule } from "../ingestion/ingestion.module";

// 依赖装配：
// - ModelsModule 导出 ModelsService（create 探针 / type·enabled 校验）。
// - IngestionModule 导出 KbRebuildService（update 改 chunkTemplate 触发 startRebuild）。
//   IngestionModule 不 import KnowledgeBasesModule（Task 16 直接 provide repository），
//   故无模块级循环，无需 forwardRef。
@Module({
  imports: [ModelsModule, IngestionModule],
  controllers: [KnowledgeBasesController],
  providers: [KnowledgeBasesRepository, KnowledgeBasesService],
  exports: [KnowledgeBasesRepository, KnowledgeBasesService],
})
export class KnowledgeBasesModule {}
