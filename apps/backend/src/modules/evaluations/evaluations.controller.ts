import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import {
  QualityOverviewQuerySchema,
  UpdateOnlineEvalSettingsRequestSchema,
  type OnlineEvalSettingsResponse,
  type QualityOverviewResponse,
  type ManualScoreResponse,
  type TraceQualityDetail,
} from "@codecrush/contracts";
import type { AuthenticatedUser } from "../../platform/security/authenticated-user";
import { EvaluationsService } from "./evaluations.service";

type AuthedRequest = { user: AuthenticatedUser };

const TRACE_ID = /^[a-f0-9]{32}$/i;

@Controller("eval/quality")
export class EvaluationsController {
  constructor(private readonly service: EvaluationsService) {}

  @Get("overview")
  async overview(@Query() raw: unknown): Promise<QualityOverviewResponse> {
    const parsed = QualityOverviewQuerySchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.service.getOverview(parsed.data);
  }

  @Get("traces/:traceId")
  async trace(@Param("traceId") traceId: string): Promise<TraceQualityDetail> {
    if (!TRACE_ID.test(traceId)) throw new BadRequestException("traceId must be 32 hex characters");
    return this.service.getTraceQuality(traceId);
  }

  /** B1/F3：手动触发单条评测（原型 §12.3「POST /eval/quality/traces/:traceId/score」）。 */
  @Post("traces/:traceId/score")
  @HttpCode(201)
  async score(
    @Param("traceId") traceId: string,
    @Req() req: AuthedRequest,
  ): Promise<ManualScoreResponse> {
    if (!TRACE_ID.test(traceId)) throw new BadRequestException("traceId must be 32 hex characters");
    return this.service.requestManualScore(traceId, req.user.email);
  }

  @Get("settings")
  async settings(): Promise<OnlineEvalSettingsResponse> {
    return this.service.getSettings();
  }

  @Put("settings")
  async update(@Body() raw: unknown): Promise<OnlineEvalSettingsResponse> {
    const parsed = UpdateOnlineEvalSettingsRequestSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.service.updateSettings(parsed.data);
  }
}
