import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { createZodDto } from "nestjs-zod";
import { CreateKnowledgeBaseRequestSchema, type KnowledgeBase } from "@codecrush/contracts";
import { KnowledgeBasesService } from "./knowledge-bases.service";

class CreateKnowledgeBaseRequestDto extends createZodDto(CreateKnowledgeBaseRequestSchema) {}

@Controller("knowledge-bases")
export class KnowledgeBasesController {
  constructor(private readonly knowledgeBasesService: KnowledgeBasesService) {}

  @Get()
  list(): KnowledgeBase[] {
    return this.knowledgeBasesService.list();
  }

  @Get(":id")
  get(@Param("id") id: string): KnowledgeBase {
    return this.knowledgeBasesService.get(id);
  }

  @Post()
  @HttpCode(201)
  create(@Body() body: CreateKnowledgeBaseRequestDto): KnowledgeBase {
    return this.knowledgeBasesService.create(body);
  }
}
