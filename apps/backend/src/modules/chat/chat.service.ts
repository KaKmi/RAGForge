import { Injectable } from "@nestjs/common";
import type { ChatRequest, ChatStreamEvent } from "@codecrush/contracts";

const MOCK_TOKENS = ["你", "好", "，", "这", "是", "M2", "桩", "回", "答", "。"];
const MOCK_TRACE_ID = "391dae938234560b16bb63f51501cb6f";

@Injectable()
export class ChatService {
  /**
   * M2 桩：返回假事件序列（token×N → citation → done）。
   * 不做真实编排；M8 接 RAG 编排内核（检索 → prompt → 生成 → 流式回写）。
   *
   * 返回数组而非异步流：skeleton 阶段一次性产出便于 e2e 断言；M8 改为 AsyncGenerator。
   */
  generateStream(_req: ChatRequest): ChatStreamEvent[] {
    const events: ChatStreamEvent[] = MOCK_TOKENS.map((delta) => ({ type: "token", delta }));
    events.push({
      type: "citation",
      citation: {
        n: 1,
        doc: "退换货政策.pdf",
        kb: "售后服务知识库",
        section: "退货条件",
        score: 0.82,
      },
    });
    events.push({ type: "done", traceId: MOCK_TRACE_ID, confidence: 0.82 });
    return events;
  }
}
