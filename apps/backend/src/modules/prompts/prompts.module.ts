import { Module } from "@nestjs/common";
import { PromptsController } from "./prompts.controller";
import { PromptsRepository } from "./prompts.repository";
import { PromptsService } from "./prompts.service";

@Module({
  controllers: [PromptsController],
  providers: [PromptsRepository, PromptsService],
  exports: [PromptsService],
})
export class PromptsModule {}
