import { GeneralChunker } from "./general-chunker";
import { estimateTokens } from "../../pipeline/estimate-tokens";
import { hardSplitByTokens } from "../../pipeline/hard-split";
import type { ChunkDraftPartial, ChunkerPort } from "../../ports/chunker.port";

const MAX_TOKENS = 512;

const QA_LINE = /^(?:问|Q)[：:]\s*(.+)$/;
const A_LINE = /^(?:答|A)[：:]\s*(.+)$/;

/** 问答模板：识别 问：/答： 或 Q:/A: 配对逐对切片；无标记时退化为 GeneralChunker 兜底。 */
export class QaChunker implements ChunkerPort {
  private readonly fallback = new GeneralChunker();

  chunk(text: string): ChunkDraftPartial[] {
    const lines = text.split("\n");
    const drafts: ChunkDraftPartial[] = [];
    let pendingQ: string | null = null;

    for (const line of lines) {
      const q = QA_LINE.exec(line.trim());
      if (q) {
        pendingQ = q[1];
        continue;
      }
      const a = A_LINE.exec(line.trim());
      if (a && pendingQ) {
        const pair = `${pendingQ}\n${a[1]}`;
        if (estimateTokens(pair) > MAX_TOKENS) {
          // 超长问答对按硬上限切分为多片，section 保持问句——保证不超 embedding 单条输入上限
          for (const piece of hardSplitByTokens(pair, MAX_TOKENS)) {
            drafts.push({ seq: drafts.length, text: piece, section: pendingQ });
          }
        } else {
          drafts.push({ seq: drafts.length, text: pair, section: pendingQ });
        }
        pendingQ = null;
      }
    }

    return drafts.length > 0 ? drafts : this.fallback.chunk(text);
  }
}
