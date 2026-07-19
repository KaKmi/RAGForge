import { Injectable, type OnModuleInit } from "@nestjs/common";
import { DocumentsService } from "../documents/documents.service";
import { EvalSetsService } from "./eval-sets.service";

/**
 * B1/F4：eval-runs 向 documents 注册 gold 过期检测器。
 *
 * 依赖方向：`eval-runs → documents`（新增边，无环——**documents 不 import 任何 eval 模块**，
 * 它只知道「有人想在文档变更时被通知」）。范式同 `EvalRunDeletionGuard`
 * （`eval-run-deletion.guard.ts`）与 `applications.service.ts:538-546` 的注册表反转。
 *
 * 后端模块间**没有 lint 边界规则**（`eslint.config.mjs` 只覆盖 frontend/contracts/otel），
 * 这条方向靠 Nest 模块图与评审维持——改动此处务必确认没有反向 import。
 */
@Injectable()
export class GoldStaleNotifier implements OnModuleInit {
  constructor(
    private readonly documents: DocumentsService,
    private readonly evalSets: EvalSetsService,
  ) {}

  onModuleInit(): void {
    this.documents.registerGoldStaleNotifier(async (docId) => {
      await this.evalSets.markGoldStaleByDocId(docId);
    });
  }
}
