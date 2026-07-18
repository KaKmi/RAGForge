import { Inject, Injectable } from "@nestjs/common";
import type { RetrievalTestRequest, RetrievalTestResponse } from "@codecrush/contracts";
import { RETRIEVER_PORT } from "./retriever.constants";
import type { RetrieverPort } from "./ports/retriever.port";

@Injectable()
export class RetrievalService {
  constructor(@Inject(RETRIEVER_PORT) private readonly retriever: RetrieverPort) {}

  async test(
    req: RetrievalTestRequest,
    observer?: (signal: "keyword_degraded" | "rerank_degraded") => void,
    // E-W2b F1：外部中止信号透传（加性可选，省略 → 行为不变）。
    signal?: AbortSignal,
  ): Promise<RetrievalTestResponse> {
    // 省略 signal/observer 时保持原调用形状（AC1-2：既有测试 0 改动）。
    const hits =
      signal !== undefined
        ? await this.retriever.retrieve(req, observer, signal)
        : observer
          ? await this.retriever.retrieve(req, observer)
          : await this.retriever.retrieve(req);
    return { hits };
  }
}
