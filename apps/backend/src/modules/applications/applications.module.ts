import { Module } from "@nestjs/common";
import { KnowledgeBasesModule } from "../knowledge-bases/knowledge-bases.module";
import { ModelsModule } from "../models/models.module";
import { NodeRuntimeModule } from "../node-runtime/node-runtime.module";
import { PromptsModule } from "../prompts/prompts.module";
import { ApplicationsController } from "./applications.controller";
import { ApplicationsRepository } from "./applications.repository";
import { ApplicationsService } from "./applications.service";
import { ReleaseCheckProcessor } from "./release-check.processor";
@Module({
  // QueueModule 是 @Global（提供 RELEASE_CHECK_QUEUE），无需在此 import；
  // NodeRuntimeModule 提供 compileAndSample 供 ReleaseCheck worker 真实预演。
  imports: [ModelsModule, PromptsModule, KnowledgeBasesModule, NodeRuntimeModule],
  controllers: [ApplicationsController],
  providers: [ApplicationsRepository, ApplicationsService, ReleaseCheckProcessor],
  exports: [ApplicationsService],
})
export class ApplicationsModule {}
