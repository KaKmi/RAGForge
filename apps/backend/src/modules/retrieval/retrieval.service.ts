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
  ): Promise<RetrievalTestResponse> {
    const hits = observer
      ? await this.retriever.retrieve(req, observer)
      : await this.retriever.retrieve(req);
    return { hits };
  }
}
