export const PROCESS_ROLES = ["api", "worker", "all"] as const;
export type ProcessRole = (typeof PROCESS_ROLES)[number];

/**
 * PROCESS_ROLE 的唯一解析点（019 Boundary 2）。main.ts 的引导分支与 tracing.ts 的
 * serviceName 在 Nest DI 建立之前调用；config.schema.ts 经 transform 委托本函数，
 * 全仓只有这一个校验器。未设/空串 → "all"（零变化默认，也是回滚路径——dotenv 里
 * `PROCESS_ROLE=` 占位行产出空串，按未设置处理）；非法值直接 throw——fail-fast 必须
 * 发生在 tracing 启动之前，严格匹配不做大小写归一。
 */
export function parseProcessRole(env: Record<string, string | undefined>): ProcessRole {
  const raw = env.PROCESS_ROLE;
  if (raw === undefined || raw === "") return "all";
  if ((PROCESS_ROLES as readonly string[]).includes(raw)) return raw as ProcessRole;
  throw new Error(`PROCESS_ROLE 非法值 "${raw}"，只接受 ${PROCESS_ROLES.join(" | ")}`);
}
