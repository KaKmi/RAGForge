import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { INGESTION_QUEUE } from "../../platform/queue/queue.constants";
import type { Queue } from "../../platform/queue/queue.port";
import { IngestionService } from "./ingestion.service";
import { INGEST_DOCUMENT_JOB, type IngestDocumentJobData } from "./ingestion-job.constants";

@Injectable()
export class IngestionProcessor implements OnModuleInit {
  constructor(
    @Inject(INGESTION_QUEUE) private readonly queue: Queue,
    private readonly ingestionService: IngestionService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.subscribe(INGEST_DOCUMENT_JOB, async (data) => {
      const job = data as IngestDocumentJobData;
      // 超集 payload 单订阅分流：带 processingRunId 走新 Run 路径（快照唯一行为源）；
      // 无此字段是迁移窗口的在途旧任务（或 flag=false 的 legacy enqueue），走旧路径。
      if (job.processingRunId) {
        await this.ingestionService.processRun(job.processingRunId);
      } else {
        await this.ingestionService.processDocument(job.documentId, job.targetVersion);
      }
    });
  }
}
