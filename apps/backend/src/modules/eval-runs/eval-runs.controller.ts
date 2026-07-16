import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import {
  CreateEvalRunRequestSchema,
  type EvalRunListItem,
  type EvalRunListResponse,
  type EvalRunReport,
} from "@codecrush/contracts";
import type { AuthenticatedUser } from "../../platform/security/authenticated-user";
import { EvalRunsService } from "./eval-runs.service";

type AuthedRequest = { user: AuthenticatedUser };

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

  /** 进度反馈用轮询（018 已知取舍 8）：前端仅在 queued/running 时 3s 拉一次本端点。 */
  @Get(":id") getReport(@Param("id") id: string): Promise<EvalRunReport> {
    return this.service.getReport(id);
  }

  /** 原型 §19.2 Popconfirm「停止后已完成的 23 条保留,未运行的不再执行?」——只置信号，worker 收尾。 */
  @Post(":id/stop") @HttpCode(204) stop(@Param("id") id: string): Promise<void> {
    return this.service.stop(id);
  }
}
