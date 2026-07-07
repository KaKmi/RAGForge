import { Module } from "@nestjs/common";
import { KnowledgeBasesController } from "./knowledge-bases.controller";
import { KnowledgeBasesService } from "./knowledge-bases.service";

@Module({
  controllers: [KnowledgeBasesController],
  providers: [KnowledgeBasesService],
})
export class KnowledgeBasesModule {}
