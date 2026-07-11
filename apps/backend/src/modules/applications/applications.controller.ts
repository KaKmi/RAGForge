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
  Query,
  Req,
} from "@nestjs/common";
import { createZodDto } from "nestjs-zod";
import {
  CreateApplicationConfigVersionRequestSchema,
  CreateApplicationRequestSchema,
  PromptUsageQuerySchema,
  UpdateApplicationRequestSchema,
  type Application,
  type ApplicationChatResult,
  type ApplicationConfigVersion,
  type ApplicationDetail,
  type PromptUsageEntry,
} from "@codecrush/contracts";
import type { AuthenticatedUser } from "../../platform/security/authenticated-user";
import { ApplicationsService } from "./applications.service";
class CreateApplicationDto extends createZodDto(CreateApplicationRequestSchema) {}
class CreateVersionDto extends createZodDto(CreateApplicationConfigVersionRequestSchema) {}
class UpdateApplicationDto extends createZodDto(UpdateApplicationRequestSchema) {}
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
}
