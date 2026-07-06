import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { createZodDto } from "nestjs-zod";
import { CreateModelRequestSchema, type ModelProvider } from "@codecrush/contracts";
import { ModelsService } from "./models.service";

class CreateModelRequestDto extends createZodDto(CreateModelRequestSchema) {}

@Controller("models")
export class ModelsController {
  constructor(private readonly modelsService: ModelsService) {}

  @Get()
  list(): ModelProvider[] {
    return this.modelsService.list();
  }

  @Get(":id")
  get(@Param("id") id: string): ModelProvider {
    return this.modelsService.get(id);
  }

  @Post()
  create(@Body() body: CreateModelRequestDto): ModelProvider {
    return this.modelsService.create(body);
  }

  @Post(":id/test")
  @HttpCode(200)
  test(@Param("id") id: string): { ok: boolean } {
    return this.modelsService.test(id);
  }
}
