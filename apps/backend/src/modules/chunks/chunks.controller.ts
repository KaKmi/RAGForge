import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { createZodDto } from "nestjs-zod";
import {
  ChunkBatchDeleteRequestSchema,
  ChunkListQuerySchema,
  type ChunkBatchDeleteResponse,
  type ChunkPageResponse,
} from "@codecrush/contracts";
import { ChunksService } from "./chunks.service";

class ChunkBatchDeleteRequestDto extends createZodDto(ChunkBatchDeleteRequestSchema) {}
class ChunkListQueryDto extends createZodDto(ChunkListQuerySchema) {}

// @Controller() 无前缀 + 方法级全路径：本控制器同时挂 documents/:id/chunks 与 chunks/batch-delete 两种前缀
@Controller()
export class ChunksController {
  constructor(private readonly chunksService: ChunksService) {}

  @Get("documents/:id/chunks")
  list(@Param("id") id: string, @Query() query: ChunkListQueryDto): Promise<ChunkPageResponse> {
    return this.chunksService.listPage(id, query);
  }

  @Post("chunks/batch-delete")
  batchDelete(@Body() body: ChunkBatchDeleteRequestDto): Promise<ChunkBatchDeleteResponse> {
    return this.chunksService.batchDelete(body.ids);
  }
}
