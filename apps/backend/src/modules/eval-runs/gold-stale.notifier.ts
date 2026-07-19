import { Injectable, type OnModuleInit } from "@nestjs/common";
import { DocumentChangeNotifier } from "../../platform/events/document-change.notifier";
import { EvalSetsService } from "./eval-sets.service";

/**
 * B1/F4：eval-runs 向 documents 注册 gold 过期检测器。
 *
 * 依赖方向：`eval-runs → platform`（platform 是所有域的下游，天然无环）。
 * 广播点刻意放在平台层而不是 `DocumentsService`：文档内容被换掉的路径有两条，
 * 第二条（`KbRebuildService` 整库重建）绕过 documents 域直接调 ingestion，
 * 注册表挂在 documents 上就会漏掉它——而那恰恰是量最大的一次过期事件。
 *
 * 范式同 `EvalRunDeletionGuard`（`eval-run-deletion.guard.ts`）：
 * 消费域自己在 onModuleInit 把回调塞进去，被通知方**不认识**评测域。
 *
 * 后端模块间**没有 lint 边界规则**（`eslint.config.mjs` 只覆盖 frontend/contracts/otel），
 * 这条方向靠 Nest 模块图与评审维持——改动此处务必确认没有反向 import。
 */
@Injectable()
export class GoldStaleNotifier implements OnModuleInit {
  constructor(
    private readonly changes: DocumentChangeNotifier,
    private readonly evalSets: EvalSetsService,
  ) {}

  onModuleInit(): void {
    this.changes.register(async (docId) => {
      await this.evalSets.markGoldStaleByDocId(docId);
    });
  }
}
