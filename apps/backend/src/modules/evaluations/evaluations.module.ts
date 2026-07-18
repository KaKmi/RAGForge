import { Module } from "@nestjs/common";
import { ChunksModule } from "../chunks/chunks.module";
import { ConversationsModule } from "../conversations/conversations.module";
import { ModelsModule } from "../models/models.module";
import { AnswerRelevancyEvaluator } from "./answer-relevancy.evaluator";
import { CitationEvaluator } from "./citation.evaluator";
import { ClickHouseEvaluationsRepository } from "./clickhouse-evaluations.repository";
import { ContextPrecisionEvaluator } from "./context-precision.evaluator";
import { CorrectnessEvaluator } from "./correctness.evaluator";
import { EvaluationInputService } from "./evaluation-input.service";
import { EvaluationJudgeService } from "./evaluation-judge.service";
import { EvaluationSpanEmitter } from "./evaluation-span.emitter";
import { EvaluationWorkerProcessor } from "./evaluation-worker.processor";
import { EvaluationsRepository } from "./evaluations.repository";
import { FaithfulnessEvaluator } from "./faithfulness.evaluator";
import { ManualScoreProcessor } from "./manual-score.processor";
import { EvaluationsController } from "./evaluations.controller";
import { EvaluationsService } from "./evaluations.service";

@Module({
  imports: [ConversationsModule, ChunksModule, ModelsModule],
  controllers: [EvaluationsController],
  providers: [
    EvaluationsRepository,
    ClickHouseEvaluationsRepository,
    EvaluationInputService,
    FaithfulnessEvaluator,
    AnswerRelevancyEvaluator,
    ContextPrecisionEvaluator,
    CorrectnessEvaluator, // E-W2a：离线 gold 对照指标（在线三指标不含它）
    CitationEvaluator, // E-W2b F4：离线 Citation 指标（仅记分卡，不进 verdict/综合分）
    EvaluationJudgeService,
    EvaluationSpanEmitter,
    EvaluationWorkerProcessor,
    ManualScoreProcessor, // B1/F3：人工「立即评测」消费者（api 角色队列）
    EvaluationsService,
  ],
  // 018 决策 A：只导出 EvaluationJudgeService 一个服务给 eval-runs——**不导出 4 个 evaluator**。
  // 「怎么判分」是 evaluations 的域知识；eval-runs 只拥有 run 生命周期。
  exports: [EvaluationsRepository, EvaluationJudgeService],
})
export class EvaluationsModule {}
