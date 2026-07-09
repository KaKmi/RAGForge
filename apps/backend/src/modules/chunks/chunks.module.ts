import { Module } from "@nestjs/common";
import { ChunksController } from "./chunks.controller";
import { ChunksRepository } from "./chunks.repository";
import { ChunksService } from "./chunks.service";
import { DocumentsModule } from "../documents/documents.module";

@Module({
  imports: [DocumentsModule],
  controllers: [ChunksController],
  providers: [ChunksRepository, ChunksService],
  exports: [ChunksRepository, ChunksService],
})
export class ChunksModule {}
