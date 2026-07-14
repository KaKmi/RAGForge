import { Module } from "@nestjs/common";
import { ClickHouseModule } from "../../platform/clickhouse/clickhouse.module";
import { ClickHouseTracesRepository } from "./clickhouse-traces.repository";
import { ClickHouseMetricsRepository } from "./clickhouse-metrics.repository";
import { MetricsController } from "./metrics.controller";
import { TracesController } from "./traces.controller";
import { TracesService } from "./traces.service";

@Module({
  imports: [ClickHouseModule],
  controllers: [TracesController, MetricsController],
  providers: [ClickHouseTracesRepository, TracesService, ClickHouseMetricsRepository],
})
export class TracesModule {}
