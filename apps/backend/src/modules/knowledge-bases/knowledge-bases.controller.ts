import { Body, Controller, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { createZodDto } from "nestjs-zod";
import {
  CreateKnowledgeBaseRequestSchema,
  RebuildKnowledgeBaseRequestSchema,
  UpdateKnowledgeBaseRequestSchema,
  type KnowledgeBase,
} from "@codecrush/contracts";
import { KnowledgeBasesService } from "./knowledge-bases.service";

class CreateKnowledgeBaseRequestDto extends createZodDto(CreateKnowledgeBaseRequestSchema) {}
class UpdateKnowledgeBaseRequestDto extends createZodDto(UpdateKnowledgeBaseRequestSchema) {}
class RebuildKnowledgeBaseRequestDto extends createZodDto(RebuildKnowledgeBaseRequestSchema) {}

@Controller("knowledge-bases")
export class KnowledgeBasesController {
  constructor(private readonly knowledgeBasesService: KnowledgeBasesService) {}

  @Get()
  list(): Promise<KnowledgeBase[]> {
    return this.knowledgeBasesService.list();
  }

  @Get(":id")
  get(@Param("id") id: string): Promise<KnowledgeBase> {
    return this.knowledgeBasesService.get(id);
  }

  @Post()
  @HttpCode(201)
  create(@Body() body: CreateKnowledgeBaseRequestDto): Promise<KnowledgeBase> {
    return this.knowledgeBasesService.create(body);
  }

  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body() body: UpdateKnowledgeBaseRequestDto,
  ): Promise<KnowledgeBase> {
    return this.knowledgeBasesService.update(id, body);
  }

  @Post(":id/rebuild")
  @HttpCode(202)
  rebuild(
    @Param("id") id: string,
    @Body() body: RebuildKnowledgeBaseRequestDto,
  ): Promise<KnowledgeBase> {
    return this.knowledgeBasesService.rebuild(id, body.scope);
  }
}
