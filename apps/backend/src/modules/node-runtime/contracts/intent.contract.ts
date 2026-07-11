import { z } from "zod";
import { NODE_CONTRACTS } from "@codecrush/contracts";
import type { NodeContract, ValidationIssue } from "./types";

const InputSchema = z.object({
  query: z.string().min(1),
  history: z.string().optional(),
});
const ReservedSchema = z.object({
  availableRoutes: z.array(z.string()),
});
const OutputSchema = z.object({
  intent: z.enum(["售前", "售后", "学习", "unknown"]),
  routeIds: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

export const INTENT_CONTRACT: NodeContract<
  z.infer<typeof InputSchema>,
  z.infer<typeof OutputSchema>,
  z.infer<typeof ReservedSchema>
> = {
  node: "intent",
  version: 1,
  key: "intent",
  consumer: "编排代码 · 拿去路由",
  weight: "重契约",
  runtimeMode: "structured",
  structuredMode: "json_schema",
  inputSchema: InputSchema,
  reservedDataSchema: ReservedSchema,
  outputSchema: OutputSchema,
  templateFields: NODE_CONTRACTS.intent.templateFields,
  systemInstructions:
    "你是 RAG 流程中的「意图识别」节点。从平台在运行时注入的候选路由中，选出与用户问题最匹配的" +
    "意图与路由，并给出置信度。只做判断，不回答问题。输出必须符合平台提供的 JSON Schema。",
  extraValidate: (output, reserved): ValidationIssue[] => {
    const illegal = output.routeIds.filter((id) => !reserved.availableRoutes.includes(id));
    if (illegal.length === 0) return [];
    return [
      {
        code: "ROUTE_ID_NOT_AVAILABLE",
        message: `routeIds 越权：${illegal.join(",")} 不在本次 availableRoutes 内`,
        field: "routeIds",
      },
    ];
  },
  fallback: () => ({ intent: "unknown", routeIds: [], confidence: 0 }),
};
