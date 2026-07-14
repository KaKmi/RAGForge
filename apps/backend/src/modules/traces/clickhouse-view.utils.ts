import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CodeCrushClickHouseClient } from "../../platform/clickhouse/clickhouse.types";

const WORKSPACE_MARKER = "pnpm-workspace.yaml";
const MAX_PARENT_SEARCH_DEPTH = 10;

/** 后端可能从 apps/backend 启动；从模块目录找 workspace 根可同时兼容 src 与 dist。 */
function resolveRepoPath(relativePath: string): string {
  let dir = __dirname;
  for (let depth = 0; depth < MAX_PARENT_SEARCH_DEPTH; depth += 1) {
    if (existsSync(join(dir, WORKSPACE_MARKER))) return join(dir, relativePath);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), relativePath);
}

export async function otelTracesTableExists(
  clickhouse: CodeCrushClickHouseClient,
): Promise<boolean> {
  const result = await clickhouse.query({
    query: "EXISTS TABLE otel_traces",
    format: "JSONEachRow",
  });
  const rows = await result.json<{ result: number }>();
  return rows[0]?.result === 1;
}

export async function loadSqlStatements(relativePath: string): Promise<string[]> {
  const sql = await readFile(resolveRepoPath(relativePath), "utf8");
  return sql
    .split(";")
    .map((statement) =>
      statement
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((statement) => statement.length > 0);
}

/** ClickHouse 的无时区 DateTime64 字符串必须显式按 UTC 解析，避免跟随服务器本地时区。 */
export function toIsoUtc(chTime: string): string {
  const match = chTime
    .trim()
    .match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?/);
  if (!match) return new Date(chTime).toISOString();
  const fraction = (match[3] ?? "").padEnd(3, "0").slice(0, 3);
  return new Date(`${match[1]}T${match[2]}.${fraction}Z`).toISOString();
}
