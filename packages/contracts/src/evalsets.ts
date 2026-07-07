import { z } from "zod";

export const EvalSetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  desc: z.string(),
  caseCount: z.number().int().nonnegative(),
});
export type EvalSet = z.infer<typeof EvalSetSchema>;

export const EvalSetListResponseSchema = z.array(EvalSetSchema);
export type EvalSetListResponse = z.infer<typeof EvalSetListResponseSchema>;
