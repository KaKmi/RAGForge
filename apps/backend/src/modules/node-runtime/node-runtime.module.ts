import { Module } from "@nestjs/common";
import { ModelsModule } from "../models/models.module";
import { NodeRuntimeService } from "./executor/node-runtime.service";

@Module({
  imports: [ModelsModule],
  providers: [NodeRuntimeService],
  exports: [NodeRuntimeService],
})
export class NodeRuntimeModule {}
