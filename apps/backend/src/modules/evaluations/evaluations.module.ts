import { Module } from "@nestjs/common";
import { ChunksModule } from "../chunks/chunks.module";
import { ConversationsModule } from "../conversations/conversations.module";
import { ModelsModule } from "../models/models.module";
import { AnswerRelevancyEvaluator } from "./answer-relevancy.evaluator";
import { ClickHouseEvaluationsRepository } from "./clickhouse-evaluations.repository";
import { ContextPrecisionEvaluator } from "./context-precision.evaluator";
import { EvaluationInputService } from "./evaluation-input.service";
import { EvaluationJudgeService } from "./evaluation-judge.service";
import { EvaluationSpanEmitter } from "./evaluation-span.emitter";
import { EvaluationWorkerProcessor } from "./evaluation-worker.processor";
import { EvaluationsRepository } from "./evaluations.repository";
import { FaithfulnessEvaluator } from "./faithfulness.evaluator";

@Module({
  imports: [ConversationsModule, ChunksModule, ModelsModule],
  providers: [
    EvaluationsRepository,
    ClickHouseEvaluationsRepository,
    EvaluationInputService,
    FaithfulnessEvaluator,
    AnswerRelevancyEvaluator,
    ContextPrecisionEvaluator,
    EvaluationJudgeService,
    EvaluationSpanEmitter,
    EvaluationWorkerProcessor,
  ],
  exports: [EvaluationsRepository],
})
export class EvaluationsModule {}
