import { Injectable, Logger } from "@nestjs/common";

export type DocumentChangeListener = (docId: string) => Promise<void>;

/**
 * B1/F4：「某个文档的内容可能变了」这一事件的**平台级**广播点。
 *
 * 为什么住在 platform 而不是 documents 域：文档内容会被换掉的路径有**两条**，且不同域——
 *  1. `DocumentsService.triggerParse` / `remove`（单文档，用户直接操作）；
 *  2. `KbRebuildService.startRebuild`（整库重建，`ingestion` 域，**绕过 DocumentsService
 *     直接调 ingestion.createRun/enqueue**）。
 * 第 2 条是系统里**量最大**的一次性过期事件（一次重建重切整个知识库的每一篇文档），
 * 最初的实现把注册表挂在 `DocumentsService` 上，于是恰恰漏掉了它。
 *
 * 把注册表放在这里，两条路径都能注册/广播，且**不产生模块环**：
 * `DocumentsModule` 与 `IngestionModule` 之间已经是 forwardRef 的互相引用，
 * 若让 ingestion 去注入 `DocumentsService` 只会把那对 forwardRef 拧得更紧。
 *
 * 监听方由消费域自行注册（当前是 eval-runs 的 `GoldStaleNotifier`）——
 * **platform 不认识任何业务域**，这里只有一个 `(docId) => Promise<void>` 的形状。
 */
@Injectable()
export class DocumentChangeNotifier {
  private readonly logger = new Logger(DocumentChangeNotifier.name);
  private readonly listeners: DocumentChangeListener[] = [];

  /**
   * fan-out 语义，故用 push（对比 `registerEvalGateProvider` 的覆盖语义：
   * 门禁只能有一个结论，通知可以有多个听众）。
   */
  register(fn: DocumentChangeListener): void {
    this.listeners.push(fn);
  }

  /**
   * 广播。**任何监听方抛错都只记日志，绝不冒泡**——
   * 评测集标不上「gold 可能过期」是体验问题；因为它把一次文档解析/删除/整库重建
   * 打回失败，是事故。逐个 try/catch 而不是整体包一层：一个监听方炸了不该让后面的收不到。
   */
  async notifyChanged(docId: string): Promise<void> {
    for (const fn of this.listeners) {
      try {
        await fn(docId);
      } catch (err) {
        this.logger.warn(`document-change listener failed doc=${docId}: ${String(err)}`);
      }
    }
  }
}
