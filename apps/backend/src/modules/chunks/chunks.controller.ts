import { Body, Controller, Get, Param, Patch } from "@nestjs/common";
import { createZodDto } from "nestjs-zod";
import { UpdateChunkEnabledRequestSchema, type Chunk } from "@codecrush/contracts";
import { ChunksService } from "./chunks.service";

class UpdateChunkEnabledRequestDto extends createZodDto(UpdateChunkEnabledRequestSchema) {}

@Controller("chunks")
export class ChunksController {
  constructor(private readonly chunksService: ChunksService) {}

  @Get(":docId")
  list(@Param("docId") docId: string): Chunk[] {
    return this.chunksService.listByDoc(docId);
  }

  @Patch(":id")
  setEnabled(@Param("id") id: string, @Body() body: UpdateChunkEnabledRequestDto): Chunk {
    return this.chunksService.setEnabled(id, body.enabled);
  }
}
