import { Module } from "@nestjs/common";
// M8.0：试运行改经 NodeRuntimeService（prompts 后端对 node-runtime 的唯一依赖，
// 仅限 try-run 转发单节点执行请求，不做数据查询/repository 访问——见
// docs/design/003-code-organization.md 补充说明，用户已确认这处窄范围例外）
import { NodeRuntimeModule } from "../node-runtime/node-runtime.module";
import { PromptsController } from "./prompts.controller";
import { PromptsRepository } from "./prompts.repository";
import { PromptsService } from "./prompts.service";

@Module({
  imports: [NodeRuntimeModule],
  controllers: [PromptsController],
  providers: [PromptsRepository, PromptsService],
  exports: [PromptsService],
})
export class PromptsModule {}
