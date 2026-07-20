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
 * 018 决策 A 曾把 `eval-runs` 定为依赖顶点。**021 决策 A 起它不再是顶点**：
 * `gaps → eval-runs` 是既定边（屏5 [进评测集] / 屏2「从坏样本生成」要在服务端批量建 gold 用例，
 * 见 `eslint.config.mjs` Boundary ⑤ 的注释），故本模块 `exports` 了 `EvalSetsService`。
 * **反向的 `eval-runs → gaps` 依然禁止**——那会立刻成环，eslint Boundary ⑤ 会拦下；
 * 屏3 的「加入问题池」按钮因此走前端组合（021 决策 B），不是后端直调 gaps。
 *
 * 它 import 谁这一半没变：`eval-runs → {chat, evaluations, applications}`
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
  /**
   * 导出**两个**：
   *  · `EvalSetsService` —— `gaps` 的 [进评测集] 要批量建 gold 用例（021 决策 A 的既定边）；
   *  · `ReplayService`（B2b）—— `gaps` 的**自动回验**要「同编排重放一次 + 即时判分」，
   *    而那正是重放已经封装好的能力。让 gaps 自己去拼 `OrchestrationService` +
   *    `EvaluationJudgeService` 反而要新开 `gaps → chat` 与 `gaps → evaluations(judge)` 两条边，
   *    且会出现第二份「怎么算这三个分」的实现——两处口径一旦漂移，回验分与重放分对不上。
   *
   * **仍不导出 run 侧的任何东西**：发起/停止评测是本域的编排入口，
   * 导出去等于把「谁能发起 run」这条边界交给调用方自觉。
   */
  exports: [EvalSetsService, ReplayService],
})
export class EvalRunsModule {}
