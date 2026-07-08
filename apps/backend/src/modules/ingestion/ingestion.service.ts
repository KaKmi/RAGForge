import { Inject, Injectable, Logger } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import type { ChunkTemplate, DocumentType } from "@codecrush/contracts";
import { BLOB_STORE } from "../../platform/storage/blob-store.constants";
import type { BlobStore } from "../../platform/storage/blob-store.port";
import { INGESTION_QUEUE } from "../../platform/queue/queue.constants";
import type { Queue } from "../../platform/queue/queue.port";
import { DocumentsRepository } from "../documents/documents.repository";
import { KnowledgeBasesRepository } from "../knowledge-bases/knowledge-bases.repository";
import { INGESTION_PIPELINE_PORT } from "./ingestion.constants";
import type { IngestionPipelinePort } from "./ports/ingestion-pipeline.port";
import { INGEST_DOCUMENT_JOB } from "./ingestion-job.constants";

const nowIso = (): string => new Date().toISOString();

// 文档终态监听端口：KbRebuildService 实现之，经此 token 由 ingestion.module 用 useExisting 绑定。
// 用 token + 懒解析（ModuleRef）而非直接 import KbRebuildService 类：KbRebuildService 构造依赖本服务
// enqueue，本服务又要在文档终态回调它——若两侧互相 import 类值会触发 ES 模块循环（TDZ）与 Nest 构造期循环依赖。
// token 解耦后运行时导入图单向（kb-rebuild → ingestion），Nest 侧本服务不构造期依赖监听器，无需 forwardRef。
export const DOCUMENT_TERMINAL_LISTENER = Symbol("DOCUMENT_TERMINAL_LISTENER");

export interface DocumentTerminalListener {
  onDocumentTerminal(kbId: string): Promise<void>;
}

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    @Inject(INGESTION_QUEUE) private readonly queue: Queue,
    @Inject(BLOB_STORE) private readonly blobStore: BlobStore,
    private readonly docsRepo: DocumentsRepository,
    private readonly kbRepo: KnowledgeBasesRepository,
    @Inject(INGESTION_PIPELINE_PORT) private readonly pipeline: IngestionPipelinePort,
    private readonly moduleRef?: ModuleRef,
  ) {}

  // 文档到达终态（ready/failed）后回调重建监听器，检查全库重建是否可原子切换。
  // 懒解析：非 Nest 场景（单测直接 new，无 moduleRef）时短路为 no-op，不影响单文档处理逻辑。
  // 全程自吞异常（含 token 未注册时 moduleRef.get 的抛错）：回调失败只 warn，
  // 绝不影响已落地的文档终态写入，也不使 pg-boss 任务失败。
  private async notifyDocumentTerminal(kbId: string): Promise<void> {
    if (!this.moduleRef) return;
    try {
      const listener = this.moduleRef.get<DocumentTerminalListener>(DOCUMENT_TERMINAL_LISTENER, {
        strict: false,
      });
      await listener.onDocumentTerminal(kbId);
    } catch (err) {
      this.logger.warn(
        `文档终态回调失败 kb=${kbId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 上传 autoParse=true 或手动 /parse 触发都走这里：立即标 queued + 发布任务，HTTP 立即返回（007 禁止同步入库）。
  // singletonKey=documentId + retryLimit=1：同一文档重复入队不并行双跑、失败不自动重试（幂等由 queue 保证）。
  async enqueue(documentId: string, targetVersion: number): Promise<void> {
    await this.docsRepo.update(documentId, { status: "queued" });
    await this.queue.publish(
      INGEST_DOCUMENT_JOB,
      { documentId, targetVersion },
      { singletonKey: documentId, retryLimit: 1 },
    );
  }

  // pg-boss worker 回调实体：读文档+所属 kb -> 取 blob -> 跑管线 -> 落地终态。
  // 阶段异常一律捕获落 failed（不抛出、不自动重试），便于 T17 kb-rebuild 在终态之上插回调。
  async processDocument(documentId: string, targetVersion: number): Promise<void> {
    const doc = await this.docsRepo.findById(documentId);
    if (!doc) return; // 文档在排队期间被删除：静默完成，不视为失败（幂等）

    await this.docsRepo.update(documentId, { status: "processing" });
    await this.docsRepo.appendLifecycleStage(documentId, {
      stage: "ingest",
      status: "running",
      startedAt: nowIso(),
      endedAt: null,
    });

    try {
      const kb = await this.kbRepo.findById(doc.kbId);
      const blob = await this.blobStore.get(doc.blobKey);
      const result = await this.pipeline.run({
        documentId,
        kbId: doc.kbId,
        docType: doc.type as DocumentType,
        chunkTemplate: (kb?.chunkTemplate ?? "general") as ChunkTemplate,
        embeddingModelId: kb?.embeddingModelId ?? "",
        targetVersion,
        blob,
      });

      // HOST 裁定：ready 但 0 切片会误导用户，按失败处理（走 catch 落 failed + 可读错误）。
      if (result.chunkCount === 0) {
        throw new Error("解析结果为空，未产生任何切片");
      }

      await this.docsRepo.update(documentId, {
        status: "ready",
        chunkVersion: targetVersion,
        parsedText: result.parsedText,
        error: null,
      });
      // 闭合起始处追加的 ingest/running 项（写 endedAt，UI 的耗时/进行中态才有终点），
      // 再追加 ready 里程碑；不闭合会让前端把该阶段永远渲染为「进行中」且耗时随 now 增长。
      await this.docsRepo.completeLifecycleStage(documentId, "ingest", {
        status: "done",
        endedAt: nowIso(),
      });
      await this.docsRepo.appendLifecycleStage(documentId, {
        stage: "ready",
        status: "done",
        startedAt: nowIso(),
        endedAt: nowIso(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.docsRepo.update(documentId, { status: "failed", error: message });
      // 同理闭合 running 项为 failed；无未闭合项（历史数据）时回退追加独立失败项。
      const closed = await this.docsRepo.completeLifecycleStage(documentId, "ingest", {
        status: "failed",
        endedAt: nowIso(),
        error: message,
      });
      if (!closed) {
        await this.docsRepo.appendLifecycleStage(documentId, {
          stage: "ingest",
          status: "failed",
          startedAt: nowIso(),
          endedAt: nowIso(),
          error: message,
        });
      }
    }
    // 终态回调：成功（ready）与失败（failed）都是终态（007 拍板 failed 亦终态，不卡住重建切换）。
    // 单一调用点放在 try/catch 之后：回调抛错既不会把已 ready 的文档误改成 failed（AC3），
    // 也不会二次触发；notifyDocumentTerminal 内部自吞异常，双保险。
    await this.notifyDocumentTerminal(doc.kbId);
  }
}
