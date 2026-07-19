import { EventsModule } from "../../platform/events/events.module";
import { Module } from "@nestjs/common";
import { ApplicationsModule } from "../applications/applications.module";
import { ChatModule } from "../chat/chat.module";
import { EvaluationsModule } from "../evaluations/evaluations.module";
import { EvalGateProviderRegistrar } from "./eval-gate.provider";
import { EvalRunDeletionGuard } from "./eval-run-deletion.guard";
import { EvalRunWorkerProcessor } from "./eval-run-worker.processor";
import { GoldStaleNotifier } from "./gold-stale.notifier";
import { EvalRunsController } from "./eval-runs.controller";
import { EvalRunsRepository } from "./eval-runs.repository";
import { EvalRunsService } from "./eval-runs.service";
import { EvalSetsController } from "./eval-sets.controller";
import { EvalSetsRepository } from "./eval-sets.repository";
import { EvalSetsService } from "./eval-sets.service";
import { ReplayController } from "./replay.controller";
import { ReplayService } from "./replay.service";

/**
 * 018 决策 A：`eval-runs` 是依赖顶点 —— 它 import 别人，别人不 import 它。
 * 唯一允许的新依赖方向：`eval-runs → {chat, evaluations, applications}`
 *  · ChatModule 提供 `OrchestrationService.runForEvaluation`（与线上同一编排路径）；
 *  · EvaluationsModule 只导出 `EvaluationJudgeService`（怎么判分是它的域知识）；
 *  · ApplicationsModule 提供 `resolveForTest`（preview=true 的显式版本解析）；
 * B1/F4 的 gold 过期检测器（`GoldStaleNotifier`）注册在 @Global 的 `DocumentChangeNotifier`
 * 上，**不需要 import 任何业务模块**——故这里没有新增 documents/ingestion 的边。
 * `EVAL_RUN_QUEUE` 来自 @Global 的 QueueModule，无需在此 import（同 ingestion/release-check）。
 */
@Module({
  imports: [ChatModule, EvaluationsModule, ApplicationsModule, EventsModule],
  controllers: [EvalSetsController, EvalRunsController, ReplayController],
  providers: [
    EvalSetsRepository,
    EvalSetsService,
    EvalRunsRepository,
    EvalRunsService,
    EvalRunWorkerProcessor,
    EvalRunDeletionGuard, // F6：onModuleInit 注册应用删除守卫
    EvalGateProviderRegistrar, // B1/F5：onModuleInit 注册上线门禁 issue 提供方
    GoldStaleNotifier, // B1/F4：onModuleInit 注册 gold 过期检测器
    ReplayService, // F7：单条重放（SSE + 即时判分）
  ],
})
export class EvalRunsModule {}
