import { z } from "zod";
import { NODE_CONTRACTS, ChatCitationSchema } from "@codecrush/contracts";
import type { NodeContract } from "./types";

const InputSchema = z.object({
  query: z.string().min(1),
  history: z.string().optional(),
  retrievalContext: z.string().optional(),
});
const ReservedSchema = z.object({
  citations: z.array(ChatCitationSchema).default([]),
});
const OutputSchema = z.object({
  text: z.string().min(1),
});

export const REPLY_CONTRACT: NodeContract<
  z.infer<typeof InputSchema>,
  z.infer<typeof OutputSchema>,
  z.infer<typeof ReservedSchema>
> = {
  node: "reply",
  version: 1,
  key: "reply",
  consumer: "终端用户直接看",
  weight: "轻契约",
  runtimeMode: "stream",
  inputSchema: InputSchema,
  reservedDataSchema: ReservedSchema,
  outputSchema: OutputSchema,
  templateFields: NODE_CONTRACTS.reply.templateFields,
  systemInstructions:
    "你是 RAG 流程中的「回复生成」节点。只依据平台提供的检索内容回答，不得编造；" +
    "引用某段知识时在句末标注对应角标 [n]。以自然语言流式回答，不要输出 JSON。",
  fallback: () => ({
    text: "很抱歉，这个问题暂时没有在知识库中找到答案，您可以联系人工客服获取进一步帮助。",
  }),
};
