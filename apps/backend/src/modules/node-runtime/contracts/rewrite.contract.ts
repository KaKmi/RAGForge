import { z } from "zod";
import { NODE_CONTRACTS } from "@codecrush/contracts";
import type { NodeContract } from "./types";

const InputSchema = z.object({
  query: z.string().min(1),
  history: z.string().optional(),
});
const OutputSchema = z.object({
  rewrittenQuery: z.string().min(1).max(1000),
  keywords: z.array(z.string()).max(20).default([]),
});

export const REWRITE_CONTRACT: NodeContract<
  z.infer<typeof InputSchema>,
  z.infer<typeof OutputSchema>,
  Record<string, never>
> = {
  node: "rewrite",
  version: 1,
  key: "rewrite",
  consumer: "编排代码 · 拿去检索",
  weight: "重契约",
  runtimeMode: "structured",
  structuredMode: "json_schema",
  inputSchema: InputSchema,
  // review round 2：非 .strict()——调用方传入的是共享 RuntimeContext（可能带
  // preview/其它节点用的字段），本节点没有专属保留字段不代表 reserved 参数本身
  // 必须是空对象；.strict() 会拒绝任何多余 key，导致真实模型调用被静默短路进
  // fallback。Zod 默认 strip 模式会安静丢弃多余 key，语义正确。
  reservedDataSchema: z.object({}),
  outputSchema: OutputSchema,
  templateFields: NODE_CONTRACTS.rewrite.templateFields,
  systemInstructions:
    "你是 RAG 流程中的「问题改写」节点。将当前问题改写成可独立理解、适合知识库检索的问题。" +
    "不要回答问题，不要添加输入中不存在的事实。输出必须符合平台提供的 JSON Schema。",
  fallback: (input) => ({ rewrittenQuery: input.query, keywords: [] }),
};
