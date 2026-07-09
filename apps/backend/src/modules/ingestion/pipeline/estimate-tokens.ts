const CJK_RANGE = /[一-鿿㐀-䶿豈-﫿]/;

/**
 * CJK 感知估算：中文按字符数计 1 token/字，非 CJK 按 4 字符≈1 token 折算，向上取整求和。
 * 展示用途（token 数只用于 UI 展示与批处理粒度参考），非计费级精度——不引入 tokenizer 依赖（007 拒绝备选）。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let nonCjk = 0;
  for (const ch of text) {
    if (CJK_RANGE.test(ch)) cjk++;
    else nonCjk++;
  }
  return cjk + Math.ceil(nonCjk / 4);
}
