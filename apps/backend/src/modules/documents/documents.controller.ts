import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UploadedFiles,
  UseInterceptors,
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { createZodDto } from "nestjs-zod";
import { UpdateDocumentMetadataRequestSchema, type Document } from "@codecrush/contracts";
import { DocumentsService, type UploadedFileLike } from "./documents.service";

class UpdateDocumentMetadataRequestDto extends createZodDto(UpdateDocumentMetadataRequestSchema) {}

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB（Global Constraints）
const MAX_FILES = 100;

// 无前缀（@Controller()）+ 每方法写全路径：本控制器同时挂
// knowledge-bases/:kbId/documents（嵌套在 KB 资源下）与 documents/:id（扁平）两种前缀，
// 单个 @Controller("documents") 无法同时表达这两种形状。
@Controller()
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Get("documents")
  list(@Query("kbId") kbId: string): Promise<Document[]> {
    return this.documentsService.list(kbId);
  }

  @Post("knowledge-bases/:kbId/documents")
  @HttpCode(201)
  @UseInterceptors(FilesInterceptor("files", MAX_FILES, { limits: { fileSize: MAX_FILE_SIZE } }))
  upload(
    @Param("kbId") kbId: string,
    @UploadedFiles() files: UploadedFileLike[],
    @Body("autoParse") autoParse?: string,
  ): Promise<Document[]> {
    // multipart 表单字段全是字符串；"false" 是字符串真值，需显式比较
    return this.documentsService.upload(kbId, files, { autoParse: autoParse !== "false" });
  }

  @Post("documents/:id/parse")
  @HttpCode(202)
  parse(@Param("id") id: string): Promise<Document> {
    return this.documentsService.triggerParse(id);
  }

  @Get("documents/:id/lifecycle")
  lifecycle(@Param("id") id: string) {
    return this.documentsService.getLifecycle(id);
  }

  @Get("documents/:id/content")
  content(@Param("id") id: string) {
    return this.documentsService.getContent(id);
  }

  @Patch("documents/:id/metadata")
  updateMetadata(
    @Param("id") id: string,
    @Body() body: UpdateDocumentMetadataRequestDto,
  ): Promise<Document> {
    return this.documentsService.updateMetadata(id, body);
  }

  @Delete("documents/:id")
  @HttpCode(204)
  remove(@Param("id") id: string): Promise<void> {
    return this.documentsService.remove(id);
  }
}
