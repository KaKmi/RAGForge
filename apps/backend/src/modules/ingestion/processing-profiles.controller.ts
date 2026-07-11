import { Controller, Get, Inject, Query } from "@nestjs/common";
import type { DocumentType, ProcessingProfileDescriptor } from "@codecrush/contracts";
import { PROFILE_REGISTRY } from "./ingestion.constants";
import type { ProfileRegistry } from "./profiles/profile-registry";

// 只读处理方案目录：前端知识库创建/编辑、文档重新解析 Modal 拉取可选方案。
// 只暴露业务描述（label/summary/supportedTypes），不泄露 normalizer/引擎实现细节（010 §前端）。
@Controller("processing-profiles")
export class ProcessingProfilesController {
  constructor(@Inject(PROFILE_REGISTRY) private readonly registry: ProfileRegistry) {}

  @Get()
  list(@Query("documentType") documentType?: DocumentType): ProcessingProfileDescriptor[] {
    return this.registry.listForType(documentType);
  }
}
