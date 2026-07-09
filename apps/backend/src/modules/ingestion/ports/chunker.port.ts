export interface ChunkDraftPartial {
  seq: number;
  text: string;
  section: string;
}

// 供需要文档/知识库上下文的分块器使用（如 CustomChunker 从文件名解析课程元信息、
// 用知识库名称拼上下文头）；general/qa 不消费此参数——TS 允许实现少声明尾参数。
export interface ChunkerMeta {
  filename: string;
  kbName: string;
}

export interface ChunkerPort {
  chunk(text: string, meta: ChunkerMeta): ChunkDraftPartial[];
}
