import { customType } from "drizzle-orm/pg-core";

/**
 * pgvector 列类型（Postgres 扩展已由 infra/postgres/init.sql 在容器初始化时启用，
 * 见 007 Design）。drizzle-orm 无内置 vector 类型，手写 customType：
 * DDL 声明 vector(1024)（平台统一维度，见 Global Constraints）；
 * 写入序列化为 pgvector 文本字面量 `[0.1,0.2,...]`；读出反解析回 number[]。
 */
export const vector1024 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(1024)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value.slice(1, -1).split(",").map(Number);
  },
});
