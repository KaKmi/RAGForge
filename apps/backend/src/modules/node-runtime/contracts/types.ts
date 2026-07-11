import type { z } from "zod";
import type { PromptNode } from "@codecrush/contracts";

export interface ValidationIssue {
  code: string;
  message: string;
  field?: string;
}

export interface NodeContract<TInput = unknown, TOutput = unknown, TReserved = unknown> {
  node: PromptNode;
  version: number;
  key: string;
  consumer: string;
  weight: "重契约" | "轻契约";
  runtimeMode: "structured" | "stream";
  structuredMode?: "json_schema";
  last?: boolean;

  inputSchema: z.ZodType<TInput>;
  reservedDataSchema: z.ZodType<TReserved>;
  outputSchema: z.ZodType<TOutput>;

  /** 复用 012 静态字段契约（NODE_CONTRACTS[node].templateFields），不重复定义 */
  templateFields: readonly string[];

  systemInstructions: string;
  extraValidate?: (output: TOutput, reserved: TReserved) => ValidationIssue[];
  fallback: (input: TInput, reserved: TReserved) => TOutput;
}
