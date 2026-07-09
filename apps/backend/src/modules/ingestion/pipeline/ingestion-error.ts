// 入库管线业务错误码：document.error 以 `[代码] 中文说明：上游详情` 格式落库，
// 前端原样展示即可读；代码可供后续检索/告警/重试策略按类归因。
export type IngestionErrorCode =
  | "PARSE_FAILED" // 解析阶段失败（损坏文件、扫描件空文本等）
  | "CHUNK_EMPTY" // 分块后没有任何切片（内容为空/全空白）
  | "EMBED_FAILED" // 向量化调用失败（上游模型服务错误）
  | "STORE_FAILED" // 切片入库（事务替换）失败
  | "INGEST_FAILED"; // 未归类的管线失败（兜底）

const FRIENDLY: Record<IngestionErrorCode, string> = {
  PARSE_FAILED: "文档解析失败",
  CHUNK_EMPTY: "解析结果为空，未产生任何切片",
  EMBED_FAILED: "向量化失败",
  STORE_FAILED: "切片入库失败",
  INGEST_FAILED: "入库处理失败",
};

export class IngestionError extends Error {
  constructor(
    readonly code: IngestionErrorCode,
    detail?: string,
  ) {
    super(detail ? `[${code}] ${FRIENDLY[code]}：${detail}` : `[${code}] ${FRIENDLY[code]}`);
    this.name = "IngestionError";
  }
}

/** 非 IngestionError 的异常统一包装为兜底码；已是业务错误则原样返回。 */
export function toIngestionError(err: unknown, code: IngestionErrorCode): IngestionError {
  if (err instanceof IngestionError) return err;
  const detail = err instanceof Error ? err.message : String(err);
  return new IngestionError(code, detail);
}
