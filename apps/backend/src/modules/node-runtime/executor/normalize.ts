/** 剥离模型输出常见的单层 Markdown 代码围栏（```json ... ``` 或 ``` ... ```） */
export function normalizeStructuredOutput(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1].trim() : trimmed;
}
