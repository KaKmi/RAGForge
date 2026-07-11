import { z } from "zod";
import { NODE_CONTRACTS } from "@codecrush/contracts";
import type { NodeContract } from "./types";

const InputSchema = z.object({
  query: z.string().min(1),
  reason: z.string().optional(),
});
const OutputSchema = z.object({
  text: z.string().min(1),
});

export const FALLBACK_CONTRACT: NodeContract<
  z.infer<typeof InputSchema>,
  z.infer<typeof OutputSchema>,
  Record<string, never>
> = {
  node: "fallback",
  version: 1,
  key: "fallback",
  consumer: "终端用户直接看",
  weight: "轻契约",
  runtimeMode: "stream",
  last: true,
  inputSchema: InputSchema,
  // review round 2：非 .strict()——同 rewrite.contract.ts 理由，调用方传入的是
  // 共享 RuntimeContext，多余 key 应被安静 strip 而非拒绝整个调用。
  reservedDataSchema: z.object({}),
  outputSchema: OutputSchema,
  templateFields: NODE_CONTRACTS.fallback.templateFields,
  systemInstructions:
    "你是 RAG 流程中的「兜底」节点。当问题超出知识库范围或上游失败时，礼貌说明暂时无法回答，" +
    "并引导用户后续动作。",
  // 011 Design §1：fallback 节点自己的 fallback 不再调用模型，直接用代码内固定文案
  fallback: () => ({
    text: "很抱歉，这个问题暂时没有在知识库中找到答案，您可以联系人工客服获取进一步帮助。",
  }),
};
