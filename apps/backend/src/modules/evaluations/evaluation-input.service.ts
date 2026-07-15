import { Injectable } from "@nestjs/common";
import { ChunksService } from "../chunks/chunks.service";
import { ConversationsService } from "../conversations/conversations.service";
import type { EvaluationInput } from "./evaluation.types";

export interface EvaluationCandidateInput {
  traceId: string;
  agentId: string;
  generationModel: string;
  retrievalChunks: Array<{ chunkId: string; finalScore: number }>;
}

export type EvaluationInputAssembly =
  | { status: "ready"; input: EvaluationInput; missingChunkIds: string[] }
  | { status: "incomplete"; reason: "turn_not_found" };

const MAX_CONTEXTS = 20;

@Injectable()
export class EvaluationInputService {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly chunks: ChunksService,
  ) {}

  async assemble(candidate: EvaluationCandidateInput): Promise<EvaluationInputAssembly> {
    const turn = await this.conversations.findEvaluationTurnByTraceId(candidate.traceId);
    if (!turn) return { status: "incomplete", reason: "turn_not_found" };

    const bestByChunkId = new Map<string, { finalScore: number; firstIndex: number }>();
    candidate.retrievalChunks.forEach((chunk, index) => {
      const current = bestByChunkId.get(chunk.chunkId);
      if (!current || chunk.finalScore > current.finalScore) {
        bestByChunkId.set(chunk.chunkId, {
          finalScore: chunk.finalScore,
          firstIndex: current?.firstIndex ?? index,
        });
      }
    });
    const ranked = [...bestByChunkId.entries()]
      .sort(
        (left, right) =>
          right[1].finalScore - left[1].finalScore || left[1].firstIndex - right[1].firstIndex,
      )
      .slice(0, MAX_CONTEXTS);
    const rows = await this.chunks.findByIds(ranked.map(([chunkId]) => chunkId));
    const textByChunkId = new Map(rows.map((row) => [row.id, row.text]));
    const missingChunkIds = ranked
      .map(([chunkId]) => chunkId)
      .filter((chunkId) => !textByChunkId.has(chunkId));

    return {
      status: "ready",
      input: {
        targetTraceId: candidate.traceId,
        question: turn.question,
        answer: turn.answer,
        contexts: ranked.flatMap(([chunkId, { finalScore }]) => {
          const text = textByChunkId.get(chunkId);
          return text === undefined ? [] : [{ chunkId, text, finalScore }];
        }),
      },
      missingChunkIds,
    };
  }
}
