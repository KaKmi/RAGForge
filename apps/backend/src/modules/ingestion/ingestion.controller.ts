import { Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import type { IngestionStatus } from "@codecrush/contracts";
import { IngestionService } from "./ingestion.service";

/**
 * 入库动作挂在 documents 路径下：
 *   POST /api/documents/:id/ingest           → 202 受理
 *   GET  /api/documents/:id/ingestion-status → mock 状态
 *
 * 单独成模块（不并入 documents）：入库是异步管线关注点，M4 会独立扩展（队列 worker）。
 */
@Controller("documents/:id")
export class IngestionController {
  constructor(private readonly ingestionService: IngestionService) {}

  @Post("ingest")
  @HttpCode(202)
  trigger(@Param("id") id: string): IngestionStatus {
    return this.ingestionService.trigger(id);
  }

  @Get("ingestion-status")
  status(@Param("id") id: string): IngestionStatus {
    return this.ingestionService.status(id);
  }
}
