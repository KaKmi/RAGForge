import { Injectable, Logger } from "@nestjs/common";

export type DocumentChangeListener = (docId: string) => Promise<void>;

/** 「文档处理结束了」的订阅者。**`ready` 与 `failed` 都会收到**，见 `registerTerminal`。 */
export type DocumentTerminalListener = (
  docId: string,
  status: "ready" | "failed",
) => Promise<void>;

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

  // ─────────────── 「文档到达终态」——与「内容变了」是两件事 ───────────────

  private readonly terminalListeners: DocumentTerminalListener[] = [];

  /**
   * 订阅「某文档处理结束了」，**`ready` 与 `failed` 都会收到**。
   *
   * 为什么不复用上面的 `notifyChanged`：那条通道的语义是「这篇文档的**内容**换了」，
   * 所以它**只在 `ready` 广播**（`IngestionService.notifyContentReplaced` 的注释写明了
   * 理由：失败时旧切片原封不动、内容没变，报「gold 可能过期」是假阳性）。
   * 而 B2b 的补库回验要的是**另一个**问题的答案——「我等的那份文档处理完了吗」，
   * 成功失败都得知道：失败时要把簇从 `filled` 放出来，否则它永远卡在一个
   * 只剩「忽略」可走的死态里（peer review P1 抓出：回验的 failed 分支曾经**永不可达**）。
   *
   * 两条通道各自 fan-out，互不影响：`GoldStaleNotifier` 继续只听内容变更，
   * `GapVerificationNotifier` 听终态。
   */
  registerTerminal(fn: DocumentTerminalListener): void {
    this.terminalListeners.push(fn);
  }

  /** 广播文档终态。与 `notifyChanged` 同样逐个自吞异常——绝不让订阅方打回文档主流程。 */
  async notifyTerminal(docId: string, status: "ready" | "failed"): Promise<void> {
    for (const fn of this.terminalListeners) {
      try {
        await fn(docId, status);
      } catch (err) {
        this.logger.warn(
          `document-terminal listener failed doc=${docId} status=${status}: ${String(err)}`,
        );
      }
    }
  }
}
