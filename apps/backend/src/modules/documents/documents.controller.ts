import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { createZodDto } from "nestjs-zod";
import { CreateDocumentRequestSchema, type Document } from "@codecrush/contracts";
import { DocumentsService } from "./documents.service";

class CreateDocumentRequestDto extends createZodDto(CreateDocumentRequestSchema) {}

@Controller("documents")
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Get()
  list(@Query("kbId") kbId?: string): Document[] {
    return this.documentsService.list(kbId);
  }

  @Get(":id")
  get(@Param("id") id: string): Document {
    return this.documentsService.get(id);
  }

  @Post()
  @HttpCode(202)
  upload(@Body() body: CreateDocumentRequestDto): Document {
    return this.documentsService.upload(body);
  }
}
