import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { KnowledgeBasesRepository } from "../knowledge-bases/knowledge-bases.repository";
import { DocumentsRepository } from "../documents/documents.repository";
import { ChunksRepository } from "../chunks/chunks.repository";
import { IngestionService, type DocumentTerminalListener } from "./ingestion.service";

// 文档终态集合：ready（成功）与 failed（失败）都算"到达终态"。
// 007 拍板：部分文档 failed 不卡住整体切换——failed 也是终态，不需人工干预即可切换。
const TERMINAL_STATUSES = new Set<string>(["ready", "failed"]);

@Injectable()
export class KbRebuildService implements DocumentTerminalListener {
  private readonly logger = new Logger(KbRebuildService.name);

  constructor(
    private readonly kbRepo: KnowledgeBasesRepository,
    private readonly docsRepo: DocumentsRepository,
    private readonly chunksRepo: ChunksRepository,
    private readonly ingestion: IngestionService,
  ) {}

  // 全库重建触发（如 chunkTemplate 变更）：building_version = active_version+1、status=building，
  // 随后为 kb 下每个文档以新版本异步入队（经 enqueue -> queue，禁止同步阻塞式重建）。
  // 空库：无文档 -> 无入队，永远不会触发 onDocumentTerminal，故此处直接原子完成切换。
  // 重建中再次调用 -> 409 语义（buildingVersion 非空），不重复发任务。
  async startRebuild(kbId: string): Promise<void> {
    const kb = await this.kbRepo.findById(kbId);
    if (!kb) return;
    if (kb.buildingVersion !== null) {
      throw new BadRequestException(`knowledge base ${kbId} is already building`);
    }

    const buildingVersion = kb.activeVersion + 1;
    await this.kbRepo.updateVersions(kbId, { buildingVersion, status: "building" });

    const docs = await this.docsRepo.findByKb(kbId);
    if (docs.length === 0) {
      // 空库：没有任何文档任务会回调，直接原子切换到新版本并清理旧切片。
      await this.finalizeSwitch(kbId, buildingVersion, kb.activeVersion);
      return;
    }

    for (const doc of docs) {
      await this.ingestion.enqueue(doc.id, buildingVersion);
    }
  }

  // 每个文档任务到达终态（ready 或 failed）后由 IngestionService.processDocument 回调。
  // 只有 kb 正在 building（buildingVersion 非空）才有意义；否则是普通单文档入库场景，no-op。
  // 全部文档终态 -> 原子切换 active<-building、清空 building、status=ready，并异步清理旧版本切片。
  async onDocumentTerminal(kbId: string): Promise<void> {
    const kb = await this.kbRepo.findById(kbId);
    // 非重建场景（普通单文档入库）：buildingVersion 为空，无需检查/切换。
    if (!kb || kb.buildingVersion === null) return;

    const docs = await this.docsRepo.findByKb(kbId);
    const allTerminal = docs.every((doc) => TERMINAL_STATUSES.has(doc.status));
    if (!allTerminal) return; // 仍有 queued/processing 文档，等待后续回调。

    await this.finalizeSwitch(kbId, kb.buildingVersion, kb.activeVersion);
  }

  // 原子切换 + 异步清理旧版本切片。切换本身是单次 updateVersions（只碰 active/building/status 三列）。
  // 旧切片清理走 fire-and-forget，不进切换调用路径的同步等待——清理失败不回滚已完成的切换。
  private async finalizeSwitch(
    kbId: string,
    buildingVersion: number,
    oldVersion: number,
  ): Promise<void> {
    await this.kbRepo.updateVersions(kbId, {
      activeVersion: buildingVersion,
      buildingVersion: null,
      status: "ready",
    });

    // Promise.resolve 包裹以兼容返回非 Promise 的实现；.catch 兜住异步清理失败，避免未处理拒绝。
    void Promise.resolve(this.chunksRepo.deleteByVersion(kbId, oldVersion)).catch(
      (err: unknown) => {
        this.logger.warn(
          `旧版本切片清理失败 kb=${kbId} version=${oldVersion}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      },
    );
  }
}
