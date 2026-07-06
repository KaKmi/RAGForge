import {
  ChatRequestSchema,
  ChatStreamEventSchema,
  type ChatRequest,
  type ChatStreamEvent,
} from "@codecrush/contracts";

const TOKEN_KEY = "token";

/**
 * 005 Revisit 1：用 fetch + ReadableStream 而非 EventSource（后者不能带 Authorization 头）。
 * M8 接真实 RAG 编排后复用此模式。
 *
 * 后端事件帧格式：`data: ${JSON}\n\n`（见 chat.controller.ts）。SSE 规范允许同一帧内
 * 有多行 `data:`（用 `\n` 拼接成单条 payload）——本实现按帧解析，仅拼接 `data:` 行，
 * 忽略注释行（`: keep-alive`）与 `event:` / `retry:` 等其它字段。
 */
export async function* openChatStream(
  req: ChatRequest,
  signal?: AbortSignal,
): AsyncIterable<ChatStreamEvent> {
  const parsed = ChatRequestSchema.parse(req);
  const token = localStorage.getItem(TOKEN_KEY);
  const resp = await fetch("/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(parsed),
    signal,
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`chat stream failed: ${resp.status} ${resp.statusText}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // 帧以空行分隔；末尾不完整的帧留在 buf 等待后续 chunk
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        const payload = extractDataPayload(frame);
        if (payload === null) continue;
        yield ChatStreamEventSchema.parse(JSON.parse(payload));
      }
    }
    // flush：后端可能未以 \n\n 结尾就 close
    if (buf.trim()) {
      const payload = extractDataPayload(buf);
      if (payload !== null) {
        yield ChatStreamEventSchema.parse(JSON.parse(payload));
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** 从一帧中提取 `data:` 行拼接的 payload；无 data 行返回 null。 */
function extractDataPayload(frame: string): string | null {
  const dataLines = frame
    .split("\n")
    .filter((l) => l.startsWith("data:"));
  if (dataLines.length === 0) return null;
  // SSE 规范：多行 data: 以 \n 拼接；去前缀 "data:"（含可选单空格）
  return dataLines.map((l) => l.slice(5).replace(/^ /, "")).join("\n");
}
