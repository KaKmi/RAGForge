import { z } from "zod";

/**
 * 通用分页响应 schema 工厂：传入 item schema，得到带 items/total/page/pageSize 的分页响应。
 *
 * 用法：`const PaginatedAgentsSchema = PaginatedResponseSchema(AgentSchema)`
 */
export function PaginatedResponseSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
  });
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
