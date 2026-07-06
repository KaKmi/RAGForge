import { Body, Controller, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { createZodDto } from "nestjs-zod";
import {
  CreateAgentRequestSchema,
  UpdateAgentRequestSchema,
  type Agent,
} from "@codecrush/contracts";
import { AgentsService } from "./agents.service";

class CreateAgentRequestDto extends createZodDto(CreateAgentRequestSchema) {}
class UpdateAgentRequestDto extends createZodDto(UpdateAgentRequestSchema) {}

@Controller("agents")
export class AgentsController {
  constructor(private readonly agentsService: AgentsService) {}

  @Get()
  list(): Agent[] {
    return this.agentsService.list();
  }

  @Get(":id")
  get(@Param("id") id: string): Agent {
    return this.agentsService.get(id);
  }

  @Post()
  @HttpCode(201)
  create(@Body() body: CreateAgentRequestDto): Agent {
    return this.agentsService.create(body);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: UpdateAgentRequestDto): Agent {
    return this.agentsService.update(id, body);
  }
}
