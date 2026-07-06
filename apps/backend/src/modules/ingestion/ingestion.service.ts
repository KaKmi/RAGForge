import { Injectable } from "@nestjs/common";
import type { IngestionStatus } from "@codecrush/contracts";

@Injectable()
export class IngestionService {
  /**
   * M2 桩：触发入库（202 受理）。M4 接真实入库管线（队列 + 切片 + 嵌入）。
   */
  trigger(documentId: string): IngestionStatus {
    return {
      documentId,
      status: "processing",
      progress: 0,
      stage: "排队中",
    };
  }

  status(documentId: string): IngestionStatus {
    // M2 桩：返回一个固定的进行中状态
    return {
      documentId,
      status: "processing",
      progress: 42,
      stage: "切片",
    };
  }
}
