import { Injectable, NotFoundException } from "@nestjs/common";
import type { Chunk } from "@codecrush/contracts";

const MOCK_CHUNKS: Chunk[] = [
  {
    id: "c1",
    docId: "d1",
    kbId: "kb1",
    seq: 0,
    text: "7天无理由退货需保留商品完好...",
    tokenCount: 128,
    section: "退换货政策 > 退货条件",
    enabled: true,
  },
  {
    id: "c2",
    docId: "d1",
    kbId: "kb1",
    seq: 1,
    text: "退货流程：1. 申请 2. 审核 3. 寄回...",
    tokenCount: 96,
    section: "退换货政策 > 退货流程",
    enabled: true,
  },
  {
    id: "c3",
    docId: "d1",
    kbId: "kb1",
    seq: 2,
    text: "已禁用切片示例...",
    tokenCount: 32,
    section: "退换货政策 > 附录",
    enabled: false,
  },
];

@Injectable()
export class ChunksService {
  listByDoc(docId: string): Chunk[] {
    return MOCK_CHUNKS.filter((c) => c.docId === docId);
  }

  setEnabled(id: string, enabled: boolean): Chunk {
    const chunk = MOCK_CHUNKS.find((c) => c.id === id);
    if (!chunk) throw new NotFoundException(`chunk ${id} not found`);
    // M2 桩：原地变更（不持久化）。M4 接 chunks 表。
    chunk.enabled = enabled;
    return chunk;
  }
}
