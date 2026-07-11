import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req } from "@nestjs/common";
import { createZodDto } from "nestjs-zod";
import {
  CreatePromptRequestSchema,
  CreatePromptVersionRequestSchema,
  MovePromptTagRequestSchema,
  PromptListQuerySchema,
  PromptNodeVersionsQuerySchema,
  type PromptDetail,
  type PromptListResponse,
  type PromptNodeVersionCandidate,
  type PromptTag,
  type PromptVersion,
} from "@codecrush/contracts";
import type { AuthenticatedUser } from "../../platform/security/authenticated-user";
import { PromptsService } from "./prompts.service";

class CreatePromptRequestDto extends createZodDto(CreatePromptRequestSchema) {}
class CreatePromptVersionRequestDto extends createZodDto(CreatePromptVersionRequestSchema) {}
class MovePromptTagRequestDto extends createZodDto(MovePromptTagRequestSchema) {}

// guard 已在 canActivate 里挂 user（jwt-auth.guard.ts:41），此处仅声明所需结构。
type AuthedRequest = { user: AuthenticatedUser };

// 012：发布/回滚端点删除；标签移动/摘除 + 节点全版本候选 + 路由式详情。
@Controller("prompts")
export class PromptsController {
  constructor(private readonly promptsService: PromptsService) {}

  @Get()
  list(@Query() raw: Record<string, unknown>): Promise<PromptListResponse> {
    return this.promptsService.list(PromptListQuerySchema.parse(raw ?? {}));
  }

  // 静态路由必须声明在 :id 之前（Nest 按声明序匹配，否则 "versions" 被 :id 捕获）
  @Get("versions")
  nodeVersions(@Query() raw: Record<string, unknown>): Promise<PromptNodeVersionCandidate[]> {
    const q = PromptNodeVersionsQuerySchema.parse(raw ?? {});
    return this.promptsService.nodeVersionCandidates(q.node);
  }

  @Get(":id")
  get(@Param("id") id: string): Promise<PromptDetail> {
    return this.promptsService.getDetail(id);
  }

  @Post()
  @HttpCode(201)
  createPrompt(
    @Body() body: CreatePromptRequestDto,
    @Req() req: AuthedRequest,
  ): Promise<PromptDetail> {
    return this.promptsService.createPrompt(body, req.user.email);
  }

  @Get(":id/versions")
  listVersions(@Param("id") id: string): Promise<PromptVersion[]> {
    return this.promptsService.listVersions(id);
  }

  @Post(":id/versions")
  @HttpCode(201)
  createVersion(
    @Param("id") id: string,
    @Body() body: CreatePromptVersionRequestDto,
    @Req() req: AuthedRequest,
  ): Promise<PromptVersion> {
    return this.promptsService.createVersion(id, body, req.user.email);
  }

  // 标签排他移动（production 与自定义同一路径，无门禁语义——012 Invariant 1）
  @Put(":id/tags")
  @HttpCode(200)
  moveTag(
    @Param("id") id: string,
    @Body() body: MovePromptTagRequestDto,
    @Req() req: AuthedRequest,
  ): Promise<PromptTag[]> {
    return this.promptsService.moveTag(id, body.name, body.versionId, req.user.email);
  }

  @Delete(":id/tags/:name")
  @HttpCode(204)
  removeTag(@Param("id") id: string, @Param("name") name: string): Promise<void> {
    return this.promptsService.removeTag(id, name);
  }

  // 删除 prompt：仅依赖 FK 事实（被应用配置引用 → 409）
  @Delete(":id")
  @HttpCode(204)
  delete(@Param("id") id: string): Promise<void> {
    return this.promptsService.delete(id);
  }
}
