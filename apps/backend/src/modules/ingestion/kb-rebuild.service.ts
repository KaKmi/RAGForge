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

  // kbId -> 本轮重建实际入队的文档 id 快照。QA 复现的死锁根因：onDocumentTerminal 若改查
  // "kb 下当前全部文档"而不是这份快照，重建期间新上传（尤其 autoParse=false 停在 pending）的
  // 文档会被一并计入终态判定，但它从未入队、永远不会到达 ready/failed，allTerminal 永远为
  // false，KB 卡死在 building 且无法自行恢复。单进程内存 Map 与仓库既有的单进程假设一致
  // （见 concerns.md「多 worker 并发双切换竞态」为已知 out-of-scope 风险，同一前提）。
  private readonly rebuildDocIds = new Map<string, Set<string>>();

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

    // 先落快照再入队：终态判定只认这份 id 集合，重建期间新上传的文档不会被计入、也不会卡住切换。
    this.rebuildDocIds.set(
      kbId,
      new Set(docs.map((doc) => doc.id)),
    );
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

    // 只检查本轮重建入队时快照的文档集合，不含重建期间新上传的文档（见类顶注释）。
    // 快照缺失（理论上不应发生：buildingVersion 非空必然经过 startRebuild 落过快照；
    // 进程重启会丢内存态，此时保守回退到旧行为，避免因快照丢失而永久卡死）。
    const targetIds = this.rebuildDocIds.get(kbId);
    const docs = await this.docsRepo.findByKb(kbId);
    const relevant = targetIds ? docs.filter((doc) => targetIds.has(doc.id)) : docs;
    // 快照里的文档若已被删除（cascade 走了），不会出现在 findByKb 结果里——视为不再阻塞。
    const allTerminal = relevant.every((doc) => TERMINAL_STATUSES.has(doc.status));
    if (!allTerminal) return; // 仍有 queued/processing 文档，等待后续回调。

    this.rebuildDocIds.delete(kbId);
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
