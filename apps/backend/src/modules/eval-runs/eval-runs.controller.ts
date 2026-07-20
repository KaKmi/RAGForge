import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import {
  CreateEvalRunRequestSchema,
  SetEvalResultIgnoredRequestSchema,
  type EvalCompareResponse,
  type EvalRunListItem,
  type EvalRunListResponse,
  type EvalRunReport,
} from "@codecrush/contracts";
import type { AuthenticatedUser } from "../../platform/security/authenticated-user";
import { EvalRunsService } from "./eval-runs.service";

type AuthedRequest = { user: AuthenticatedUser };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertRunId(value: string, parameter: string): void {
  if (!UUID_RE.test(value)) throw new BadRequestException(`${parameter} must be a UUID`);
}

/** 原型 §7 / 决策 F：`/admin/eval/runs` 与 `/admin/eval/runs/:runId` 的后端。 */
@Controller("eval/runs")
export class EvalRunsController {
  constructor(private readonly service: EvalRunsService) {}

  @Get() list(): Promise<EvalRunListResponse> {
    return this.service.list();
  }

  @Post() @HttpCode(201) create(
    @Body() raw: unknown,
    @Req() req: AuthedRequest,
  ): Promise<EvalRunListItem> {
    const parsed = CreateEvalRunRequestSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.service.create(parsed.data, req.user.email);
  }

  /**
   * F8 屏4 版本对比。**必须声明在 `@Get(":id")` 之前**——否则 "compare" 被吞成 id
   * （Nest 按声明序匹配）。
   */
  @Get("compare") compare(
    @Query("a") a: string,
    @Query("b") b: string,
  ): Promise<EvalCompareResponse> {
    if (!a || !b) throw new BadRequestException("compare requires both a and b run ids");
    assertRunId(a, "a");
    assertRunId(b, "b");
    return this.service.compare(a, b);
  }

  /** 进度反馈用轮询（018 已知取舍 8）：前端仅在 queued/running 时 3s 拉一次本端点。 */
  @Get(":id") getReport(@Param("id") id: string): Promise<EvalRunReport> {
    assertRunId(id, "id");
    return this.service.getReport(id);
  }

  /** 原型 §19.2 Popconfirm「停止后已完成的 23 条保留,未运行的不再执行?」——只置信号，worker 收尾。 */
  @Post(":id/stop") @HttpCode(204) stop(@Param("id") id: string): Promise<void> {
    assertRunId(id, "id");
    return this.service.stop(id);
  }

  /**
   * B2b 屏3 行尾「标记忽略」（原型 `:322`）。粒度是**逐 case**：`caseId` 是 case 身份
   * （不是 `case_version_id`），仓储层经 `eval_case_versions.case_id` 桥接，
   * 覆盖该 case 在本 run 内的全部 `repeat_index` 行。204 无响应体。
   */
  @Patch(":runId/results/:caseId/ignore") @HttpCode(204) setResultIgnored(
    @Param("runId") runId: string,
    @Param("caseId") caseId: string,
    @Body() raw: unknown,
  ): Promise<void> {
    assertRunId(runId, "runId");
    assertRunId(caseId, "caseId");
    const parsed = SetEvalResultIgnoredRequestSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.service.setResultIgnored(runId, caseId, parsed.data.ignored);
  }
}
