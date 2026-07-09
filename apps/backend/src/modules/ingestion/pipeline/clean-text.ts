/** 默认清洗：去控制字符（保留换行/制表符）、把 3+ 连续空行压成 2 行、首尾 trim。
 * 按字符码比较排除控制字符（不用正则转义字符，避免转义序列在工具链中被误解析）。 */
function isStrippableControlChar(code: number): boolean {
  if (code === 9 || code === 10 || code === 13) return false; // \t \n \r 保留
  return (code >= 0 && code <= 31) || code === 127;
}

export function cleanText(text: string): string {
  let noControl = "";
  for (const ch of text) {
    if (!isStrippableControlChar(ch.charCodeAt(0))) noControl += ch;
  }
  const squeezed = noControl.replace(/\n{3,}/g, "\n\n");
  return squeezed.trim();
}
