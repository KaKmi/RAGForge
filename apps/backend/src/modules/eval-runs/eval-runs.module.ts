import { Module } from "@nestjs/common";
import { ApplicationsModule } from "../applications/applications.module";
import { ChatModule } from "../chat/chat.module";
import { EvaluationsModule } from "../evaluations/evaluations.module";
import { EvalRunWorkerProcessor } from "./eval-run-worker.processor";
import { EvalRunsController } from "./eval-runs.controller";
import { EvalRunsRepository } from "./eval-runs.repository";
import { EvalRunsService } from "./eval-runs.service";
import { EvalSetsController } from "./eval-sets.controller";
import { EvalSetsRepository } from "./eval-sets.repository";
import { EvalSetsService } from "./eval-sets.service";

/**
 * 018 决策 A：`eval-runs` 是依赖顶点 —— 它 import 别人，别人不 import 它。
 * 唯一允许的新依赖方向：`eval-runs → {chat, evaluations, applications}`
 *  · ChatModule 提供 `OrchestrationService.runForEvaluation`（与线上同一编排路径）；
 *  · EvaluationsModule 只导出 `EvaluationJudgeService`（怎么判分是它的域知识）；
 *  · ApplicationsModule 提供 `resolveForTest`（preview=true 的显式版本解析）。
 * `EVAL_RUN_QUEUE` 来自 @Global 的 QueueModule，无需在此 import（同 ingestion/release-check）。
 */
@Module({
  imports: [ChatModule, EvaluationsModule, ApplicationsModule],
  controllers: [EvalSetsController, EvalRunsController],
  providers: [
    EvalSetsRepository,
    EvalSetsService,
    EvalRunsRepository,
    EvalRunsService,
    EvalRunWorkerProcessor,
  ],
})
export class EvalRunsModule {}
