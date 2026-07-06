import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { createZodDto } from "nestjs-zod";
import {
  CreatePromptVersionRequestSchema,
  type Prompt,
  type PromptVersion,
} from "@codecrush/contracts";
import { PromptsService } from "./prompts.service";

class CreatePromptVersionRequestDto extends createZodDto(CreatePromptVersionRequestSchema) {}

@Controller("prompts")
export class PromptsController {
  constructor(private readonly promptsService: PromptsService) {}

  @Get()
  list(): Prompt[] {
    return this.promptsService.list();
  }

  @Get(":id")
  get(@Param("id") id: string): Prompt {
    return this.promptsService.get(id);
  }

  @Get(":id/versions")
  listVersions(@Param("id") id: string): PromptVersion[] {
    return this.promptsService.listVersions(id);
  }

  @Post(":id/versions")
  @HttpCode(201)
  createVersion(
    @Param("id") id: string,
    @Body() body: CreatePromptVersionRequestDto,
  ): PromptVersion {
    return this.promptsService.createVersion(id, body);
  }
}
