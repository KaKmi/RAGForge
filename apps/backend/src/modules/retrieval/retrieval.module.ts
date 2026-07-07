import { Module } from "@nestjs/common";
import { RetrievalController } from "./retrieval.controller";
import { RetrievalService } from "./retrieval.service";

@Module({
  controllers: [RetrievalController],
  providers: [RetrievalService],
})
export class RetrievalModule {}
