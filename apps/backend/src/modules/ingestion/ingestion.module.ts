import { Module } from "@nestjs/common";
import { IngestionController } from "./ingestion.controller";
import { IngestionService } from "./ingestion.service";

@Module({
  controllers: [IngestionController],
  providers: [IngestionService],
})
export class IngestionModule {}
