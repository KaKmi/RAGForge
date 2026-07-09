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
      const { documentId, targetVersion } = data as IngestDocumentJobData;
      await this.ingestionService.processDocument(documentId, targetVersion);
    });
  }
}
