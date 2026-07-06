import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { createZodDto } from "nestjs-zod";
import { RetrievalTestRequestSchema, type RetrievalTestResponse } from "@codecrush/contracts";
import { RetrievalService } from "./retrieval.service";

class RetrievalTestRequestDto extends createZodDto(RetrievalTestRequestSchema) {}

@Controller("retrieval")
export class RetrievalController {
  constructor(private readonly retrievalService: RetrievalService) {}

  @Post("test")
  @HttpCode(200)
  test(@Body() body: RetrievalTestRequestDto): RetrievalTestResponse {
    return this.retrievalService.test(body);
  }
}
