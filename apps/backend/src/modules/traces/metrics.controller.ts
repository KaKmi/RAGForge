import { BadRequestException, Controller, Get, Param, Query } from "@nestjs/common";
import {
  MetricsQuerySchema,
  type MetricsAppResponse,
  type MetricsOverviewResponse,
  type MetricsQuery,
} from "@codecrush/contracts";
import { ClickHouseMetricsRepository } from "./clickhouse-metrics.repository";

function parseMetricsQuery(raw: unknown): MetricsQuery {
  const result = MetricsQuerySchema.safeParse(raw);
  if (!result.success) throw new BadRequestException(result.error.issues);
  return result.data;
}

@Controller("metrics")
export class MetricsController {
  constructor(private readonly repo: ClickHouseMetricsRepository) {}

  @Get("overview")
  async overview(@Query() raw: unknown): Promise<MetricsOverviewResponse> {
    return this.repo.getOverview(parseMetricsQuery(raw));
  }

  @Get("apps/:id")
  async app(
    @Param("id") id: string,
    @Query() raw: unknown,
  ): Promise<MetricsAppResponse> {
    return this.repo.getAppMetrics(id, parseMetricsQuery(raw));
  }
}
