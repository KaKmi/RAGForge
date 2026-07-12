import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import { createZodDto } from "nestjs-zod";
import {
  CreateApplicationConfigVersionRequestSchema,
  CreateApplicationRequestSchema,
  MoveApplicationTagRequestSchema,
  PromptUsageQuerySchema,
  UpdateApplicationRequestSchema,
  type Application,
  type ApplicationChatResult,
  type ApplicationConfigVersion,
  type ApplicationDetail,
  type ApplicationTag,
  type PromptUsageEntry,
  type ReleaseCheck,
} from "@codecrush/contracts";
import type { AuthenticatedUser } from "../../platform/security/authenticated-user";
import { ApplicationsService } from "./applications.service";
class CreateApplicationDto extends createZodDto(CreateApplicationRequestSchema) {}
class CreateVersionDto extends createZodDto(CreateApplicationConfigVersionRequestSchema) {}
class UpdateApplicationDto extends createZodDto(UpdateApplicationRequestSchema) {}
class MoveApplicationTagDto extends createZodDto(MoveApplicationTagRequestSchema) {}
type AuthedRequest = { user: AuthenticatedUser };
@Controller("applications")
export class ApplicationsController {
  constructor(private readonly service: ApplicationsService) {}
  @Get() list(): Promise<Application[]> {
    return this.service.list();
  }
  @Get("prompt-usage") usage(@Query() raw: Record<string, unknown>): Promise<PromptUsageEntry[]> {
    const parsed = PromptUsageQuerySchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException("promptId 参数非法");
    return this.service.promptUsage(parsed.data.promptId);
  }
  @Get(":id") detail(@Param("id") id: string): Promise<ApplicationDetail> {
    return this.service.getDetail(id);
  }
  @Post() @HttpCode(201) create(
    @Body() body: CreateApplicationDto,
    @Req() req: AuthedRequest,
  ): Promise<ApplicationDetail> {
    return this.service.create(body, req.user.email);
  }
  @Patch(":id") update(
    @Param("id") id: string,
    @Body() body: UpdateApplicationDto,
    @Req() req: AuthedRequest,
  ): Promise<Application> {
    return this.service.updateBase(id, body, req.user.email);
  }
  @Delete(":id") @HttpCode(204) delete(@Param("id") id: string): Promise<void> {
    return this.service.delete(id);
  }
  @Get(":id/config-versions") versions(
    @Param("id") id: string,
  ): Promise<ApplicationConfigVersion[]> {
    return this.service.listVersions(id);
  }
  @Get(":id/config-versions/:versionId") version(
    @Param("id") id: string,
    @Param("versionId") versionId: string,
  ): Promise<ApplicationConfigVersion> {
    return this.service.getVersion(id, versionId);
  }
  @Post(":id/config-versions") @HttpCode(201) createVersion(
    @Param("id") id: string,
    @Body() body: CreateVersionDto,
    @Req() req: AuthedRequest,
  ): Promise<ApplicationConfigVersion> {
    return this.service.createVersion(id, body, req.user.email);
  }
  @Post(":id/config-versions/:versionId/chat") @HttpCode(200) chat(
    @Param("id") id: string,
    @Param("versionId") versionId: string,
  ): Promise<ApplicationChatResult> {
    return this.service.tryVersionChat(id, versionId);
  }

  // —— M7b 自定义命名标签（production 走 PUT /production 受门禁流程，不经这里）——
  @Get(":id/config-version-tags") listTags(@Param("id") id: string): Promise<ApplicationTag[]> {
    return this.service.listTags(id);
  }
  @Put(":id/config-version-tags") @HttpCode(200) moveTag(
    @Param("id") id: string,
    @Body() body: MoveApplicationTagDto,
    @Req() req: AuthedRequest,
  ): Promise<ApplicationTag[]> {
    return this.service.moveTag(id, body.name, body.versionId, req.user.email);
  }
  @Delete(":id/config-version-tags/:name") @HttpCode(204) removeTag(
    @Param("id") id: string,
    @Param("name") name: string,
  ): Promise<void> {
    return this.service.removeTag(id, name);
  }

  // —— M7b ReleaseCheck（静态失败 422；否则 201 建异步检查 + 轮询）——
  @Post(":id/config-versions/:versionId/release-checks") @HttpCode(201) startReleaseCheck(
    @Param("id") id: string,
    @Param("versionId") versionId: string,
    @Req() req: AuthedRequest,
  ): Promise<ReleaseCheck> {
    return this.service.startReleaseCheck(id, versionId, req.user.email);
  }
  @Get(":id/release-checks/:checkId") getReleaseCheck(
    @Param("id") id: string,
    @Param("checkId") checkId: string,
  ): Promise<ReleaseCheck> {
    return this.service.getReleaseCheck(id, checkId);
  }
}
