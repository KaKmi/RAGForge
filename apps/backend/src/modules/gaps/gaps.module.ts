import { Module } from "@nestjs/common";
import { EventsModule } from "../../platform/events/events.module";
import { DocumentsModule } from "../documents/documents.module";
import { EvalRunsModule } from "../eval-runs/eval-runs.module";
import { EvaluationsModule } from "../evaluations/evaluations.module";
import { KnowledgeBasesModule } from "../knowledge-bases/knowledge-bases.module";
import { ModelsModule } from "../models/models.module";
import { ClickHouseGapsRepository } from "./clickhouse-gaps.repository";
import { GapCollectorProcessor } from "./gap-collector.processor";
import { GapFillController } from "./gap-fill.controller";
import { GapFillService } from "./gap-fill.service";
import { GapPromoteController } from "./gap-promote.controller";
import { GapPromoteService } from "./gap-promote.service";
import { GapVerificationNotifier } from "./gap-verification.notifier";
import { GapVerificationService } from "./gap-verification.service";
import { GapsController } from "./gaps.controller";
import { GapsRepository } from "./gaps.repository";
import { GapsService } from "./gaps.service";

/**
 * 知识缺口 / 问题池域（021 决策 A + B2b 决策 I）。
 *
 * **依赖顶点**：它 import `evaluations`（判官版本与 embedding 模型设置，只读）、`models`
 * （chat / embedTexts）、`eval-runs`（批量建 gold 用例，021 决策 A 的既定边），
 * B2b 再加两条（决策 I）：
 *  · `documents` —— `[补知识库]` 第③步把人审后的问答交给**既有**上传/切片/embedding 管线；
 *  · `knowledge-bases` —— 入库前校验目标 KB `status === 'ready'`（只读）。
 *
 * ⚠️ `KnowledgeBasesModule` **必须自己 import**，不能指望 `DocumentsModule` 带进来：
 * 后者内部虽然 `forwardRef` 了它，但 `exports` 只有 `[DocumentsRepository, DocumentsService]`，
 * 不重新导出 `KnowledgeBasesRepository`。少了这一行，`GapFillService` 解析依赖时会在应用启动
 * 期抛 `Nest can't resolve dependencies`——而单测发现不了（spec 手工 new，不走 DI 图）。
 *
 * 但**没有任何模块 import 它**——`eslint.config.mjs` 的 Boundary ⑤ 机械保证。
 * 故这里 `exports` 是空的：导出任何东西都等于邀请别人建反向边。
 * 屏3 的「加入问题池」按钮走**前端组合**（021 决策 B），不是 `eval-runs → gaps`。
 *
 * `GapCollectorProcessor` 在这里注册后，它的 `onModuleInit` 才会挂上 cron
 * （`GAP_COLLECT_CRON`，每 30 分钟，worker 角色）——Task 5 交付时它还没有任何 module，等于不运行。
 * ClickHouse 客户端与 drizzle 都来自 `@Global()` 的 platform 模块，无需在此 import。
 */
@Module({
  imports: [
    EvaluationsModule,
    ModelsModule,
    EvalRunsModule,
    DocumentsModule,
    KnowledgeBasesModule,
    /**
     * B2b 自动回验的触发源（`DocumentChangeNotifier`）。
     *
     * ⚠️ `EventsModule` **不是 `@Global()`**——它自己的注释写明「刻意不用 @Global」，
     * 因为本仓有测试自行拼装局部模块图，@Global 只在「图里某处 import 过」时才生效。
     * 必须显式列在这里。注意 `eval-runs.module.ts` 的头注释把它误称作「@Global 的」，
     * **照它的 imports 数组抄，别照它的注释抄**。
     */
    EventsModule,
  ],
  controllers: [GapsController, GapPromoteController, GapFillController],
  providers: [
    GapsRepository,
    ClickHouseGapsRepository,
    GapsService,
    GapPromoteService,
    GapFillService,
    GapVerificationService,
    GapVerificationNotifier, // B2b：onModuleInit 注册「文档 ready → 自动回验」
    GapCollectorProcessor,
  ],
})
export class GapsModule {}
