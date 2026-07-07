import { Injectable, NotFoundException } from "@nestjs/common";
import type { CreateKnowledgeBaseRequest, KnowledgeBase } from "@codecrush/contracts";

const MOCK_KBS: KnowledgeBase[] = [
  {
    id: "kb1",
    name: "售后服务知识库",
    desc: "售后政策与流程",
    embeddingModelId: "m2",
    docsCount: 86,
    chunksCount: 3412,
    status: "ready",
    updatedAt: "2026-06-30T00:00:00.000Z",
  },
  {
    id: "kb2",
    name: "产品说明书知识库",
    desc: "产品规格与使用说明",
    embeddingModelId: "m2",
    docsCount: 42,
    chunksCount: 1680,
    status: "building",
    progress: 62,
    updatedAt: "2026-07-01T00:00:00.000Z",
  },
];

@Injectable()
export class KnowledgeBasesService {
  list(): KnowledgeBase[] {
    return MOCK_KBS;
  }

  get(id: string): KnowledgeBase {
    const kb = MOCK_KBS.find((k) => k.id === id);
    if (!kb) throw new NotFoundException(`knowledge base ${id} not found`);
    return kb;
  }

  create(req: CreateKnowledgeBaseRequest): KnowledgeBase {
    // M2 桩：仅回显，不持久化（M4 接入库管线）
    return {
      id: `kb${MOCK_KBS.length + 1}`,
      docsCount: 0,
      chunksCount: 0,
      status: "building",
      progress: 0,
      updatedAt: new Date().toISOString(),
      ...req,
    };
  }
}
