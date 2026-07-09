import { Module } from "@nestjs/common";
import { RetrievalController } from "./retrieval.controller";
import { RetrievalService } from "./retrieval.service";
import { RETRIEVER_PORT } from "./retriever.constants";
import { PgHybridRetriever } from "./adapters/pg-hybrid-retriever.adapter";
import { ChunksModule } from "../chunks/chunks.module";
import { ModelsModule } from "../models/models.module";
import { KnowledgeBasesModule } from "../knowledge-bases/knowledge-bases.module";

// 无环风险：没有任何模块 import RetrievalModule（008 §模块边界已核实），可以直接三个 imports，
// 不需要 KnowledgeBasesModule 那种「直接 provide 绕开 import」的手法。
// retrieval → knowledge-bases 是对 003 依赖图的增补（只读 activeVersion），008 已记录。
@Module({
  imports: [ChunksModule, ModelsModule, KnowledgeBasesModule],
  controllers: [RetrievalController],
  providers: [RetrievalService, { provide: RETRIEVER_PORT, useClass: PgHybridRetriever }],
})
export class RetrievalModule {}
