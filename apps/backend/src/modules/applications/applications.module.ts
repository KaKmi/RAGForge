import { Module } from "@nestjs/common";
import { KnowledgeBasesModule } from "../knowledge-bases/knowledge-bases.module";
import { ModelsModule } from "../models/models.module";
import { PromptsModule } from "../prompts/prompts.module";
import { ApplicationsController } from "./applications.controller";
import { ApplicationsRepository } from "./applications.repository";
import { ApplicationsService } from "./applications.service";
@Module({
  imports: [ModelsModule, PromptsModule, KnowledgeBasesModule],
  controllers: [ApplicationsController],
  providers: [ApplicationsRepository, ApplicationsService],
  exports: [ApplicationsService],
})
export class ApplicationsModule {}
