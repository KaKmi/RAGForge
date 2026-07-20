import { randomUUID } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { DocumentsRepository } from "../documents/documents.repository";
import { ReplayService } from "../eval-runs/replay.service";
import { VERIFY_PASS_THRESHOLD } from "./gap.constants";
import { GapsService } from "./gaps.service";

/**
 * 入库后的**自动回验**（021 决策 K，原型 §9 `:370`）：
 *
 * > 入库完成后，后台自动对簇内代表问题跑一次重放 + 质量评分；新分数 ≥80 → 状态「已回验✓」
 * > 并显示改善（41→89）；仍低 → 状态退回「待处理」+ 橙色提示「补库后仍低分，建议查检索」。
 *
 * **没有 HTTP 端点**，唯一入口是 `GapVerificationNotifier`（文档 ready 事件）。原型写的是
 * 「后台**自动**」——加一个「立即回验」按钮就是把自动化降级成又一个要人记得点的步骤。
 *
 * 重放走 `eval-runs` 的 `ReplayService`（既有能力，`gaps → eval-runs` 是决策 A 的允许边），
 * 不自己拼 orchestration + judge：那要新开两条边，还会造出第二份「怎么算这三个分」的实现。
 */
@Injectable()
export class GapVerificationService {
  private readonly logger = new Logger(GapVerificationService.name);

  constructor(
    private readonly gaps: GapsService,
    private readonly replay: ReplayService,
    private readonly documents: DocumentsRepository,
  ) {}

  /**
   * 对一个 `filled` 簇做一次回验。**任何分支都要把簇推离 `filled`**——留在那儿就是个
   * 没人会再管的死态（系统事件都已发生过，用户只剩「忽略」可选）。
   */
  async verifyCluster(clusterId: string, now = new Date()): Promise<void> {
    const cluster = await this.gaps.mustFindForFill(clusterId);
    if (cluster.status !== "filled") {
      // 已经被别的事件处理过（或压根不是等回验的簇）。文档事件是 fan-out 广播，
      // 同一份文档的多次通知都会走到这里，这条 return 就是幂等保证。
      return;
    }

    const documentId = cluster.fillTargetDocumentId;
    if (!documentId) {
      // `submitFill` 一定会写它；没有就是数据坏了。当作入库失败处理，让用户能重走向导。
      this.logger.error(`filled 簇没有 fill_target_document_id，无法回验：cluster=${clusterId}`);
      await this.gaps.recordVerifyIngestFailed(clusterId, now);
      return;
    }

    const document = await this.documents.findById(documentId);
    if (document?.status === "failed") {
      // 文档自己没解析成——**不是**「补库后仍低分」。两者都回 `pending`，但只有后者打复发标，
      // UI 文案也不同（「文档处理失败，可重新提交」vs「补库后仍低分(62)，建议检查检索配置」）。
      this.logger.warn(`补库文档处理失败，回验取消：cluster=${clusterId} doc=${documentId}`);
      await this.gaps.recordVerifyIngestFailed(clusterId, now);
      return;
    }
    if (document?.status !== "ready") {
      // 还在处理中（或文档已被删）。终态通道只在 ready/failed 发，走到这里多半是
      // 文档记录当场又变了。静默返回等下一次事件——**不**推进状态，
      // 免得把一次时序意外变成一个错误结论。
      return;
    }

    if (!cluster.fillVerifyApplicationId || !cluster.fillVerifyConfigVersionId) {
      this.logger.error(`filled 簇缺回验用的应用/版本，无法回验：cluster=${clusterId}`);
      // 数据坏了 ≠ 缺口复发。不打复发标，否则运营会去查一个根本没被测过的「复发」。
      await this.gaps.recordVerifyInconclusive(clusterId, now);
      return;
    }

    const score = await this.replayAndScore(
      clusterId,
      cluster.representativeQuestion,
      cluster.fillVerifyApplicationId,
      cluster.fillVerifyConfigVersionId,
    );

    if (score === null) {
      /**
       * **没测出分数** ≠ 「测出来很低」。绝不假装通过——「已回验✓」是给人看的信任凭据，
       * 凭一次没跑成的评分发出去比不发更糟；但也不打复发标，否则「判官 API key 过期」
       * 这一件事会显示成「这批缺口全都复发了」。
       */
      this.logger.warn(`回验未能得出分数（判官不可用或重放无结果）：cluster=${clusterId}`);
      await this.gaps.recordVerifyInconclusive(clusterId, now);
      return;
    }

    if (score >= VERIFY_PASS_THRESHOLD) {
      await this.gaps.recordVerifyPass(clusterId, score, now);
    } else {
      await this.gaps.recordVerifyFail(clusterId, score, now);
    }
  }

  /**
   * 跑一次重放并取三分的 `LEAST`。
   *
   * 口径与屏5 的 `avgQuality` 同源（`min(三个非空指标)`），这样「41→89」两端可比——
   * 左端是簇内各 item 的 min 的均值，右端是这一次重放的 min。**不掺 correctness**：
   * 补进知识库的是资料，不是 gold 要点，没有可比对的标准答案。
   */
  private async replayAndScore(
    clusterId: string,
    question: string,
    applicationId: string,
    configVersionId: string,
  ): Promise<number | null> {
    /**
     * `ReplayService` 按 `sourceTraceId` 做 60s 限频（面向「用户狂点重放」）。回验是系统动作，
     * 不该被那把锁拦下：同一个簇补库失败后很快再补一次是合理操作，撞上 429 会让第二次回验
     * 无声无息地变成「未通过」。故每次用一个**全新**的合法 32 位十六进制，绕开限频；
     * 簇的身份靠日志里的 `cluster=` 字段追溯（该 id 只用于限频键与日志，不落任何库）。
     */
    const syntheticTraceId = randomUUID().replace(/-/g, "");

    try {
      for await (const event of this.replay.stream(
        { applicationId, configVersionId, question, sourceTraceId: syntheticTraceId },
        "system:gap-verification",
      )) {
        if (event.type !== "replay_scores") continue;
        return leastOrNull(event.faithfulness, event.answerRelevancy, event.contextPrecision);
      }
      // 流跑完了却没有 `replay_scores` 帧：答案为空 / 编排报错 / 裁判未配置。
      return null;
    } catch (error) {
      this.logger.warn(
        `回验重放失败：cluster=${clusterId}（${error instanceof Error ? error.message : String(error)}）`,
      );
      return null;
    }
  }
}

/**
 * 三分取最小值，**任一为 null 则结果为 null**。
 *
 * 不能用 `Math.min`：它把 `null` 当 0，于是「裁判没评出忠实度」会被当成「忠实度 0 分」，
 * 一条本可能通过的回验被判成惨败。与 PG 的 `LEAST` 语义不同是刻意的——那边忽略 NULL，
 * 而这里三个分是同一次判分的整体，缺一个就说明这次判分不完整，不该给结论。
 */
function leastOrNull(...scores: Array<number | null>): number | null {
  if (scores.some((s) => s === null)) return null;
  return Math.min(...(scores as number[]));
}
