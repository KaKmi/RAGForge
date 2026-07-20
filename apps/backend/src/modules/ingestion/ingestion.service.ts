import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import type { ChunkTemplate, DocumentType, ProcessingProfileRef } from "@codecrush/contracts";
import { BLOB_STORE } from "../../platform/storage/blob-store.constants";
import type { BlobStore } from "../../platform/storage/blob-store.port";
import { AppConfigService } from "../../platform/config/config.service";
import { DocumentChangeNotifier } from "../../platform/events/document-change.notifier";
import { INGESTION_QUEUE } from "../../platform/queue/queue.constants";
import type { Queue } from "../../platform/queue/queue.port";
import { DocumentsRepository } from "../documents/documents.repository";
import { KnowledgeBasesRepository } from "../knowledge-bases/knowledge-bases.repository";
import { INGESTION_PIPELINE_PORT, PROFILE_REGISTRY } from "./ingestion.constants";
import type { IngestionPipelinePort } from "./ports/ingestion-pipeline.port";
import { IngestionError } from "./pipeline/ingestion-error";
import { INGEST_DOCUMENT_JOB } from "./ingestion-job.constants";
import { ProcessingRunsRepository, isActiveRunConflict } from "./processing-runs.repository";
import type { ProcessingRunRow } from "./schema";
import type { ProcessingProfileSnapshot } from "./profiles/processing-profile";
import {
  PROCESSING_PROFILES,
  ProfileRegistry,
  chunkTemplateToProfileRef,
} from "./profiles/profile-registry";

const nowIso = (): string => new Date().toISOString();

// running 态 Run 超过此时长仍被重复投递 → 判为僵尸（worker 崩溃残留），放行重跑；
// 之内则视为正常并发重复投递，跳过（幂等）。
const ZOMBIE_RUN_MS = 15 * 60 * 1000;

export interface CreateRunOptions {
  // 显式换 Profile（重新解析 Modal 选新方案）：建 Run 前写回文档 override，供后续重建/重解析继承。
  profileRef?: ProcessingProfileRef;
  // mode:"retry"：定位最近 failed Run 复用其冻结快照；无失败 Run 则回退当前有效 Profile 重解析。
  retry?: boolean;
}

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
    private readonly runsRepo: ProcessingRunsRepository,
    @Inject(PROFILE_REGISTRY) private readonly registry: ProfileRegistry,
    private readonly config: AppConfigService,
    private readonly moduleRef?: ModuleRef,
    // B1/F4：gold 过期广播。@Optional 是为了单测里直接 new 本服务的既有装配仍成立
    // （不传即不广播，与 moduleRef 同一取舍）；Nest 侧由 IngestionModule 的 EventsModule 提供。
    @Optional() private readonly changes?: DocumentChangeNotifier,
  ) {}

  /**
   * B1/F4：文档内容**真的换掉之后**才广播 gold 过期（spec §4.2 逐字「二者完成后需通知 eval 域」）。
   *
   * 为什么不在入队时广播（那是第一版的做法）：`triggerParse` / `startRebuild` 只是把任务
   * 丢进队列，此刻切片内容一个字都没变。用户若在解析窗口内点「确认仍有效」清掉标志，
   * 解析随后完成、内容真换了，而**不会再有第二次广播**——那条用例从此静默失去过期提示。
   * 整库重建逐篇重切，这个窗口是分钟级的，不是理论值。
   *
   * 只在 `ready` 广播、不在 `failed` 广播：失败时旧切片原封不动（chunkVersion 未前移），
   * 内容没变就不该报过期——顺带消掉了入队即广播的那类假阳性。
   *
   * 广播失败只记日志（`DocumentChangeNotifier` 内部已逐监听方自吞），绝不影响已落地的文档终态。
   */
  private async notifyContentReplaced(documentId: string): Promise<void> {
    if (!this.changes) return;
    try {
      await this.changes.notifyChanged(documentId);
    } catch (err) {
      this.logger.warn(
        `文档变更广播失败 doc=${documentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * B2b：广播「这份文档处理结束了」（`ready` / `failed` 都发）。
   *
   * 与 `notifyContentReplaced` 分成两条通道，因为它们回答的是不同问题：
   * 那条说「内容换了」（故只在 ready 发，失败时旧切片没动、报过期是假阳性）；
   * 这条说「处理完了」，补库回验要据此把等待中的缺口簇放出来——**失败尤其要发**。
   * 同样自吞异常：订阅方炸了绝不影响已落地的文档终态。
   */
  private async notifyDocumentSettled(
    documentId: string,
    status: "ready" | "failed",
  ): Promise<void> {
    if (!this.changes) return;
    try {
      await this.changes.notifyTerminal(documentId, status);
    } catch (err) {
      this.logger.warn(
        `文档终态广播失败 doc=${documentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

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

    // B1/F4：只有走到 ready 才算「内容真的换了」，见 notifyContentReplaced。
    let contentReplaced = false;
    try {
      const kb = await this.kbRepo.findById(doc.kbId);
      const blob = await this.blobStore.get(doc.blobKey);
      const template = (kb?.chunkTemplate ?? "general") as ChunkTemplate;
      const profileRef = chunkTemplateToProfileRef(template);
      const profile = PROCESSING_PROFILES.find(
        (candidate) =>
          candidate.id === profileRef.profileId && candidate.version === profileRef.profileVersion,
      );
      if (!profile) throw new IngestionError("PROFILE_INVALID", `${template} 无兼容 Profile`);
      const result = await this.pipeline.run({
        documentId,
        kbId: doc.kbId,
        docType: doc.type as DocumentType,
        snapshot: structuredClone(profile),
        embeddingModelId: kb?.embeddingModelId ?? "",
        targetVersion,
        blob,
        docName: doc.name,
        kbName: kb?.name ?? "",
      });

      // HOST 裁定：ready 但 0 切片会误导用户，按失败处理（走 catch 落 failed + 可读错误）。
      if (result.chunkCount === 0) {
        throw new IngestionError("CHUNK_EMPTY");
      }

      await this.docsRepo.update(documentId, {
        status: "ready",
        chunkVersion: targetVersion,
        parsedText: result.markdown ?? result.parsedText,
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
      contentReplaced = true;
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
    if (contentReplaced) await this.notifyContentReplaced(documentId);
    // B2b：终态广播（ready **与** failed 都发）。与上面那条「内容变了」是两件事——
    // 补库回验等的是「我那份文档处理完了吗」，失败也必须知道，否则等它的缺口簇
    // 会永远卡在 `filled`（那个态只剩「忽略」可走）。
    await this.notifyDocumentSettled(documentId, contentReplaced ? "ready" : "failed");
    await this.notifyDocumentTerminal(doc.kbId);
  }

  // M4.1 新入库路径：为文档建一条冻结快照的 Processing Run 并入队。特性开关分流不在此方法内——
  // 调用方（DocumentsService/KbRebuildService）按 config.processingProfilesEnabled 决定走此法还是 legacy enqueue。
  // Profile 解析优先级：显式 ref > 文档 override > KB default > chunkTemplate 反查兜底。
  async createRun(documentId: string, opts: CreateRunOptions = {}): Promise<ProcessingRunRow> {
    const doc = await this.docsRepo.findById(documentId);
    if (!doc) throw new NotFoundException(`document ${documentId} not found`);
    const kb = await this.kbRepo.findById(doc.kbId);
    if (!kb) throw new NotFoundException(`knowledge base ${doc.kbId} not found`);
    const targetVersion = kb.buildingVersion ?? kb.activeVersion;

    let snapshot: ProcessingProfileSnapshot | null = null;
    if (opts.retry) {
      // 复用最近一次失败 Run 的冻结快照：确保重试与原次「同方案同版本」，不受注册表后续变更影响。
      const prev = (await this.runsRepo.findByDocument(documentId)).find(
        (run) => run.status === "failed",
      );
      if (prev) snapshot = prev.profileSnapshot as unknown as ProcessingProfileSnapshot;
      // 无失败 Run：回退到当前有效 Profile 重解析（落入下方解析链）。
    }

    if (!snapshot) {
      const ref: ProcessingProfileRef =
        opts.profileRef ??
        (doc.profileOverrideId && doc.profileOverrideVersion
          ? { profileId: doc.profileOverrideId, profileVersion: doc.profileOverrideVersion }
          : kb.defaultProfileId && kb.defaultProfileVersion
            ? { profileId: kb.defaultProfileId, profileVersion: kb.defaultProfileVersion }
            : chunkTemplateToProfileRef((kb.chunkTemplate ?? "general") as ChunkTemplate));
      const def = this.registry.get(ref.profileId, ref.profileVersion);
      if (!def) {
        throw new BadRequestException(
          `[PROFILE_VERSION_UNAVAILABLE] 处理方案 ${ref.profileId}@${ref.profileVersion} 不可用`,
        );
      }
      if (!def.supportedTypes.includes(doc.type as DocumentType)) {
        throw new BadRequestException(`处理方案 ${def.label} 不支持 ${doc.type} 类型文档`);
      }
      if (opts.profileRef) {
        // 显式换 Profile = 单文档覆盖（010 In-scope）：写回 override，供后续重建/重解析继承。
        await this.docsRepo.update(documentId, {
          profileOverrideId: ref.profileId,
          profileOverrideVersion: ref.profileVersion,
        });
      }
      // 冻结：深拷贝隔离注册表定义对象，此后改注册表不影响已建 Run（AC4）。
      snapshot = structuredClone(def);
    }

    let run: ProcessingRunRow;
    try {
      run = await this.runsRepo.insert({
        documentId,
        kbId: doc.kbId,
        targetVersion,
        profileId: snapshot.id,
        profileVersion: snapshot.version,
        // jsonb 列以 Record<string,unknown> 保存（schema 域内不引用 profile 实现类型），此处存冻结快照。
        profileSnapshot: snapshot as unknown as Record<string, unknown>,
        status: "queued",
      });
    } catch (err) {
      // partial unique dpr_active_doc_unique：同文档已有 queued/running Run → 409，不重复入队。
      if (isActiveRunConflict(err)) throw new ConflictException("该文档已有处理任务进行中");
      throw err;
    }
    await this.docsRepo.update(documentId, { status: "queued" });
    await this.queue.publish(
      INGEST_DOCUMENT_JOB,
      // 超集 payload：processingRunId 走新路径；旧镜像 worker 忽略此字段仍可消费。
      { processingRunId: run.id, documentId, targetVersion },
      { singletonKey: run.id, retryLimit: 1 },
    );
    return run;
  }

  // pg-boss worker 新路径回调：以 Run 冻结快照为唯一行为源跑管线，落地 Run 与文档终态。
  // 重复投递幂等 + 僵尸兜底：succeeded/failed 跳过；running 且未超时跳过；running 超时（崩溃残留）重跑。
  async processRun(runId: string): Promise<void> {
    const run = await this.runsRepo.findById(runId);
    if (!run) return; // Run 不存在（已删/幂等）：静默返回。
    if (run.status === "succeeded" || run.status === "failed") return;
    if (run.status === "running") {
      const age = run.startedAt ? Date.now() - run.startedAt.getTime() : Infinity;
      if (age < ZOMBIE_RUN_MS) return; // 正常并发重复投递：跳过。
    }

    const doc = await this.docsRepo.findById(run.documentId);
    if (!doc) {
      await this.runsRepo.update(runId, {
        status: "failed",
        error: "文档已删除",
        endedAt: new Date(),
      });
      return;
    }

    await this.runsRepo.update(runId, { status: "running", startedAt: new Date() });
    await this.docsRepo.update(run.documentId, { status: "processing" });
    await this.docsRepo.appendLifecycleStage(run.documentId, {
      stage: "ingest",
      status: "running",
      startedAt: nowIso(),
      endedAt: null,
    });

    // B1/F4：只有走到 ready 才算「内容真的换了」，见 notifyContentReplaced。
    let contentReplaced = false;
    try {
      const kb = await this.kbRepo.findById(run.kbId);
      const blob = await this.blobStore.get(doc.blobKey);
      const result = await this.pipeline.run({
        documentId: run.documentId,
        kbId: run.kbId,
        docType: doc.type as DocumentType,
        snapshot: run.profileSnapshot as unknown as ProcessingProfileSnapshot,
        embeddingModelId: kb?.embeddingModelId ?? "",
        targetVersion: run.targetVersion,
        processingRunId: run.id,
        blob,
        docName: doc.name,
        kbName: kb?.name ?? "",
      });
      // Canonical 产物归档：稳定 key 便于按 Run 溯源/复现（parsed_text 仍写 markdown 全文兼容旧读端）。
      const canonicalBlobKey = `kb/${run.kbId}/${run.documentId}/runs/${run.id}/canonical.json`;
      await this.blobStore.put(
        canonicalBlobKey,
        Buffer.from(JSON.stringify(result.canonical), "utf8"),
      );
      await this.runsRepo.update(runId, {
        status: "succeeded",
        parserEngine: result.parserEngine,
        parserVersion: result.parserVersion,
        canonicalBlobKey,
        warnings: result.warnings,
        metrics: result.metrics,
        endedAt: new Date(),
        error: null,
      });
      await this.docsRepo.update(run.documentId, {
        status: "ready",
        chunkVersion: run.targetVersion,
        parsedText: result.markdown,
        error: null,
      });
      await this.docsRepo.completeLifecycleStage(run.documentId, "ingest", {
        status: "done",
        endedAt: nowIso(),
      });
      await this.docsRepo.appendLifecycleStage(run.documentId, {
        stage: "ready",
        status: "done",
        startedAt: nowIso(),
        endedAt: nowIso(),
      });
      contentReplaced = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.runsRepo.update(runId, { status: "failed", error: message, endedAt: new Date() });
      await this.docsRepo.update(run.documentId, { status: "failed", error: message });
      const closed = await this.docsRepo.completeLifecycleStage(run.documentId, "ingest", {
        status: "failed",
        endedAt: nowIso(),
        error: message,
      });
      if (!closed) {
        await this.docsRepo.appendLifecycleStage(run.documentId, {
          stage: "ingest",
          status: "failed",
          startedAt: nowIso(),
          endedAt: nowIso(),
          error: message,
        });
      }
    }
    if (contentReplaced) await this.notifyContentReplaced(run.documentId);
    await this.notifyDocumentSettled(run.documentId, contentReplaced ? "ready" : "failed");
    await this.notifyDocumentTerminal(run.kbId);
  }
}
