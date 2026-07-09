import { estimateTokens } from "./estimate-tokens";

// 句子边界：中英文句末标点与换行（保留标点在句尾）。
const SENTENCE_BOUNDARY = /(?<=[。！？；!?;])|(?<=\n)/;

/**
 * 硬上限切分：把超过 maxTokens 的文本切成若干 ≤ maxTokens 的片段。
 * 优先按句子边界贪心装包；单句仍超长时按字符扫描强切（CJK 1 字 ≈ 1 token 语义下安全）。
 * 目的：embedding 服务商对单条输入有硬性长度上限（如 8192），分块的 512 token
 * 软上限一旦被"无空行长段"（典型如 PDF 抽取文本）击穿，向量化整篇失败——
 * 这里保证任何产出片段都不超过硬上限，且内容零丢失。
 */
export function hardSplitByTokens(text: string, maxTokens: number): string[] {
  if (estimateTokens(text) <= maxTokens) return [text];

  const sentences = text.split(SENTENCE_BOUNDARY).filter((s) => s.length > 0);
  const out: string[] = [];
  let buffer = "";

  const flush = (): void => {
    const trimmed = buffer.trim();
    if (trimmed) out.push(trimmed);
    buffer = "";
  };

  for (const sentence of sentences) {
    if (estimateTokens(sentence) > maxTokens) {
      // 单句超长（极端：无标点长串）——按字符扫描强切
      flush();
      out.push(...sliceByTokens(sentence, maxTokens));
      continue;
    }
    const candidate = buffer + sentence;
    if (buffer && estimateTokens(candidate) > maxTokens) {
      flush();
      buffer = sentence;
    } else {
      buffer = candidate;
    }
  }
  flush();
  return out;
}

// 字符级强切：逐字累计 token 估算，到上限即断。CJK 1 字 1 token、非 CJK 4 字 1 token，
// 用保守步进（每次至多 maxTokens 个字符）避免逐字循环开销过大。
function sliceByTokens(text: string, maxTokens: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    // 从"最多 maxTokens 字符"（CJK 最坏情形）起步，向上探到不超限的最长前缀
    let take = Math.min(rest.length, maxTokens);
    while (take < rest.length && estimateTokens(rest.slice(0, take + 1)) <= maxTokens) {
      take++;
    }
    const piece = rest.slice(0, take).trim();
    if (piece) out.push(piece);
    rest = rest.slice(take);
  }
  return out;
}
