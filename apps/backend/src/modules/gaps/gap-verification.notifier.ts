import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { DocumentChangeNotifier } from "../../platform/events/document-change.notifier";
import { GapVerificationService } from "./gap-verification.service";
import { GapsRepository } from "./gaps.repository";

/**
 * 「补库文档处理完了 → 自动回验」的接线（B2b 决策 K）。
 *
 * 范式与 `eval-runs` 的 `GoldStaleNotifier` **逐字同款**：消费域自己在 `onModuleInit` 里
 * 往平台层的 `DocumentChangeNotifier` 注册一个 `(docId) => Promise<void>`，
 * 被通知方（documents / ingestion）**不认识** gaps。依赖方向是 `gaps → platform`，天然无环。
 *
 * 为什么不另起一个轮询 processor（设计阶段认真比过）：`IngestionService` 在文档走到 `ready`
 * 时本来就会广播，轮询等于自己再造一遍已经存在的信号，还要额外扛一张「谁在等谁」的状态表
 * 和一份 cron。一份文档对应且仅对应一个 `filled` 簇——这与 `GoldStaleNotifier` 面对的
 * 「一个 docId 对应一批要标记的用例」是同一类查询，那边用注册表解决得很好。
 *
 * ⚠️ `EventsModule` **不是 `@Global()`**（它自己的注释写明「刻意不用 @Global」），
 * 所以 `GapsModule` 必须显式 import 它。注意 `eval-runs.module.ts` 的头注释错误地把
 * `DocumentChangeNotifier` 称作「@Global 的」——**照它的 imports 数组抄，别照它的注释抄**。
 */
@Injectable()
export class GapVerificationNotifier implements OnModuleInit {
  private readonly logger = new Logger(GapVerificationNotifier.name);

  constructor(
    private readonly changes: DocumentChangeNotifier,
    private readonly repo: GapsRepository,
    private readonly verification: GapVerificationService,
  ) {}

  onModuleInit(): void {
    this.changes.register(async (docId) => {
      /**
       * 广播是 fan-out 的：**每一份**文档变更都会走到这里，绝大多数与问题池无关。
       * 先按 `fill_target_document_id` 窄查一次（有 partial index），没命中就立刻返回——
       * 这条回调在每次文档解析完成时都跑，不能让它变成一次昂贵的扫描。
       */
      const cluster = await this.repo.findClusterByFillTargetDocument(docId);
      if (!cluster) return;

      /**
       * 这里**不判 status**，交给 `verifyCluster` 判：状态与文档状态的组合有好几种
       * （filled+ready → 回验、filled+failed → 入库失败、非 filled → 已被处理过），
       * 判定集中在一处才不会两边漂移。
       *
       * 抛错**只记日志不冒泡**：`DocumentChangeNotifier.notifyChanged` 虽然自己也逐个
       * try/catch（一个监听方炸了不影响别的），但回验失败绝不该有任何机会影响文档主流程——
       * 那是「补库的附加动作把一次正常的文档解析打回失败」，本末倒置。
       */
      try {
        await this.verification.verifyCluster(cluster.id);
      } catch (error) {
        this.logger.error(
          `自动回验失败：cluster=${cluster.id} doc=${docId}（${
            error instanceof Error ? error.message : String(error)
          }）`,
        );
      }
    });
  }
}
