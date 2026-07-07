import { Body, Controller, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import { createZodDto } from "nestjs-zod";
import {
  CreatePromptRequestSchema,
  CreatePromptVersionRequestSchema,
  type Prompt,
  type PromptVersion,
} from "@codecrush/contracts";
import type { AuthenticatedUser } from "../../platform/security/authenticated-user";
import { PromptsService } from "./prompts.service";

class CreatePromptRequestDto extends createZodDto(CreatePromptRequestSchema) {}
class CreatePromptVersionRequestDto extends createZodDto(CreatePromptVersionRequestSchema) {}

// guard 已在 canActivate 里挂 user（jwt-auth.guard.ts:41），此处仅声明所需结构。
type AuthedRequest = { user: AuthenticatedUser };

@Controller("prompts")
export class PromptsController {
  constructor(private readonly promptsService: PromptsService) {}

  @Get()
  list(): Promise<Prompt[]> {
    return this.promptsService.list();
  }

  @Get(":id")
  get(@Param("id") id: string): Promise<Prompt> {
    return this.promptsService.get(id);
  }

  @Post()
  @HttpCode(201)
  createPrompt(@Body() body: CreatePromptRequestDto, @Req() req: AuthedRequest): Promise<Prompt> {
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

  // D2：publish 与 rollback 双端点委托同一 service.promote()；D16：传 req.user.email 刷 prompts.updatedBy
  @Post(":id/versions/:versionId/publish")
  @HttpCode(200)
  publish(
    @Param("id") id: string,
    @Param("versionId") versionId: string,
    @Req() req: AuthedRequest,
  ): Promise<PromptVersion> {
    return this.promptsService.promote(id, versionId, req.user.email);
  }

  @Post(":id/versions/:versionId/rollback")
  @HttpCode(200)
  rollback(
    @Param("id") id: string,
    @Param("versionId") versionId: string,
    @Req() req: AuthedRequest,
  ): Promise<PromptVersion> {
    return this.promptsService.promote(id, versionId, req.user.email);
  }
}
