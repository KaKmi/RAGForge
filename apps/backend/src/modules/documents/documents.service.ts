import { Injectable, NotFoundException } from "@nestjs/common";
import type { CreateDocumentRequest, Document } from "@codecrush/contracts";

const MOCK_DOCS: Document[] = [
  {
    id: "d1",
    kbId: "kb1",
    name: "退换货政策.pdf",
    type: "pdf",
    size: 102400,
    chunksCount: 24,
    status: "ready",
    stage: "已完成",
    blobKey: "blob/d1",
    updatedAt: "2026-06-30T00:00:00.000Z",
  },
  {
    id: "d2",
    kbId: "kb1",
    name: "售后流程.md",
    type: "markdown",
    size: 8192,
    chunksCount: 12,
    status: "ingest",
    stage: "切片中",
    updatedAt: "2026-06-30T00:00:00.000Z",
  },
];

@Injectable()
export class DocumentsService {
  list(kbId?: string): Document[] {
    return kbId ? MOCK_DOCS.filter((d) => d.kbId === kbId) : MOCK_DOCS;
  }

  get(id: string): Document {
    const doc = MOCK_DOCS.find((d) => d.id === id);
    if (!doc) throw new NotFoundException(`document ${id} not found`);
    return doc;
  }

  upload(req: CreateDocumentRequest): Document {
    // M2 桩：上传受理（202），不实际落对象存储（M4 接存储 + 入库管线）
    return {
      id: `d${MOCK_DOCS.length + 1}`,
      chunksCount: 0,
      status: "upload",
      stage: "已上传",
      updatedAt: new Date().toISOString(),
      ...req,
    };
  }
}
