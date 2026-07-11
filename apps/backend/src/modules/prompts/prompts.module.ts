import { Module } from "@nestjs/common";
// 012 §6：试运行经 ModelsService.chatText() 走模型端口——prompts 不触碰解密密钥/直接 HTTP
import { ModelsModule } from "../models/models.module";
import { PromptsController } from "./prompts.controller";
import { PromptsRepository } from "./prompts.repository";
import { PromptsService } from "./prompts.service";

@Module({
  imports: [ModelsModule],
  controllers: [PromptsController],
  providers: [PromptsRepository, PromptsService],
  exports: [PromptsService],
})
export class PromptsModule {}
