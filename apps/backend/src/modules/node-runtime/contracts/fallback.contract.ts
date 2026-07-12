import { z } from "zod";
import { NODE_CONTRACTS } from "@codecrush/contracts";
import type { NodeContract } from "./types";

// fallback 是纯文本契约，用户保存的 Prompt 正文就是最终输出，不消费运行时字段。
const InputSchema = z.object({});
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
  systemInstructions: "兜底节点直接返回管理员配置的纯文本，不调用模型。",
  // 仅在存量/异常数据正文为空时使用平台保底文案。
  fallback: () => ({
    text: "很抱歉，这个问题暂时没有在知识库中找到答案，您可以联系人工客服获取进一步帮助。",
  }),
};
