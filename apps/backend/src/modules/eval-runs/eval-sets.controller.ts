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
import {
  CreateEvalCaseRequestSchema,
  CreateEvalSetRequestSchema,
  EvalCaseRefQuerySchema,
  ImportEvalCasesRequestSchema,
  UpdateEvalCaseRequestSchema,
  UpdateEvalSetRequestSchema,
  type EvalCase,
  type EvalCaseListResponse,
  type EvalCaseRefListResponse,
  type EvalSet,
  type EvalSetListResponse,
  type ImportEvalCasesResponse,
} from "@codecrush/contracts";
import type { AuthenticatedUser } from "../../platform/security/authenticated-user";
import { EvalSetsService } from "./eval-sets.service";

type AuthedRequest = { user: AuthenticatedUser };

/** 原型 §5 / 决策 F：屏2 `/admin/eval/sets` 的后端；与既有 `eval/quality` 同族。 */
@Controller("eval/sets")
export class EvalSetsController {
  constructor(private readonly service: EvalSetsService) {}

  /**
   * B1/F2：必须声明在**所有含 `:id` 的路由之前**——否则一旦有人补上 `@Get(":id")`，
   * "case-refs" 会被当成 id 吞掉（`eval-runs.controller.ts:49` 记过这个真实教训）。
   */
  @Get("case-refs") caseRefs(@Query() raw: unknown): Promise<EvalCaseRefListResponse> {
    const parsed = EvalCaseRefQuerySchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.service.findCaseRefsBySourceTrace(parsed.data.sourceTraceId);
  }

  @Get() list(): Promise<EvalSetListResponse> {
    return this.service.list();
  }

  @Post() @HttpCode(201) create(@Body() raw: unknown, @Req() req: AuthedRequest): Promise<EvalSet> {
    const parsed = CreateEvalSetRequestSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.service.create(parsed.data, req.user.email);
  }

  @Patch(":id") update(@Param("id") id: string, @Body() raw: unknown): Promise<EvalSet> {
    const parsed = UpdateEvalSetRequestSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.service.update(id, parsed.data);
  }

  @Delete(":id") @HttpCode(204) remove(@Param("id") id: string): Promise<void> {
    return this.service.remove(id);
  }

  @Get(":id/cases") listCases(@Param("id") id: string): Promise<EvalCaseListResponse> {
    return this.service.listCases(id);
  }

  @Post(":id/cases") @HttpCode(201) createCase(
    @Param("id") id: string,
    @Body() raw: unknown,
    @Req() req: AuthedRequest,
  ): Promise<EvalCase> {
    const parsed = CreateEvalCaseRequestSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.service.createCase(id, parsed.data, req.user.email);
  }

  @Patch(":id/cases/:caseId") updateCase(
    @Param("id") id: string,
    @Param("caseId") caseId: string,
    @Body() raw: unknown,
  ): Promise<EvalCase> {
    const parsed = UpdateEvalCaseRequestSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.service.updateCase(id, caseId, parsed.data);
  }

  @Delete(":id/cases/:caseId") @HttpCode(204) removeCase(
    @Param("id") id: string,
    @Param("caseId") caseId: string,
  ): Promise<void> {
    return this.service.removeCase(id, caseId);
  }

  /**
   * B1/F4：原型 §18.B「人工『确认仍有效』清标志」。不产生新版本（内容根本没变）。
   * 200 而非 201：这是对既有用例的状态变更，没有创建任何资源。
   */
  @Post(":id/cases/:caseId/confirm-gold") @HttpCode(200) confirmGold(
    @Param("id") id: string,
    @Param("caseId") caseId: string,
  ): Promise<EvalCase> {
    return this.service.confirmGold(id, caseId);
  }

  /** CSV 在前端解析（018 决策 D13），这里只收行数组。§19.1：>1000 行整体拒（Zod `.max(1000)`）。 */
  @Post(":id/import") @HttpCode(200) importCases(
    @Param("id") id: string,
    @Body() raw: unknown,
    @Req() req: AuthedRequest,
  ): Promise<ImportEvalCasesResponse> {
    const parsed = ImportEvalCasesRequestSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.service.importCases(id, parsed.data.rows, req.user.email);
  }
}
