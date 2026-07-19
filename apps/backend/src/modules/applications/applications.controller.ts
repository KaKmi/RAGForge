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
  PublishProductionRequestSchema,
  UnpublishProductionRequestSchema,
  UpdateApplicationRequestSchema,
  type Application,
  type ApplicationChatResult,
  type ApplicationConfigVersion,
  type ApplicationDetail,
  type EvalGateStatus,
  type ApplicationTag,
  type PromptUsageEntry,
  type ReleaseCheck,
  type ResolvedApplicationConfig,
} from "@codecrush/contracts";
import type { AuthenticatedUser } from "../../platform/security/authenticated-user";
import { ApplicationsService } from "./applications.service";
class CreateApplicationDto extends createZodDto(CreateApplicationRequestSchema) {}
class CreateVersionDto extends createZodDto(CreateApplicationConfigVersionRequestSchema) {}
class UpdateApplicationDto extends createZodDto(UpdateApplicationRequestSchema) {}
class MoveApplicationTagDto extends createZodDto(MoveApplicationTagRequestSchema) {}
class PublishProductionDto extends createZodDto(PublishProductionRequestSchema) {}
class UnpublishProductionDto extends createZodDto(UnpublishProductionRequestSchema) {}
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
  /** B1/F5：屏4「去上线」按钮态的数据来源。只读，不建 ReleaseCheck、不产生副作用。 */
  @Get(":id/eval-gate") evalGate(
    @Param("id") id: string,
    @Query("configVersionId") configVersionId: string,
  ): Promise<EvalGateStatus> {
    if (!configVersionId) throw new BadRequestException("configVersionId 必填");
    return this.service.getEvalGateStatus(id, configVersionId);
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

  // —— M7b 管理员标签预览解析（Q1：非 production 标签仅管理员；全局 JWT 即管理员面；
  //     匿名公开 resolvePublic 仅作 service 端口，端点随 M8 chat）——
  @Get(":idOrSlug/resolve") resolve(
    @Param("idOrSlug") idOrSlug: string,
    @Query("tag") tag: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<ResolvedApplicationConfig> {
    return this.service.resolveByTag(idOrSlug, tag, req.user.email);
  }

  // —— M7b production 上线/回滚/下线（passed check + expected 指针 CAS + 归属守卫）——
  @Put(":id/production") @HttpCode(200) publish(
    @Param("id") id: string,
    @Body() body: PublishProductionDto,
    @Req() req: AuthedRequest,
  ): Promise<Application> {
    return this.service.publishProduction(id, body, req.user.email);
  }
  @Delete(":id/production") @HttpCode(200) unpublish(
    @Param("id") id: string,
    @Body() body: UnpublishProductionDto,
    @Req() req: AuthedRequest,
  ): Promise<Application> {
    return this.service.unpublishProduction(id, body.expectedProductionVersionId, req.user.email);
  }
}
