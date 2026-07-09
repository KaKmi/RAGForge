import { pgTable } from "drizzle-orm/pg-core";
import { vector1024 } from "../src/platform/persistence/pgvector-type";

// vector1024(name) 返回的是 PgCustomColumnBuilder；getSQLType/mapToDriverValue/
// mapFromDriverValue 只存在于构建后的 PgCustomColumn 实例上（drizzle-orm 0.45 行为，
// 与列在真实表中被 pgTable() 实例化时一致），故经由 pgTable 构建后取列断言。
describe("vector1024 customType", () => {
  const testTable = pgTable("vector1024_test", { embedding: vector1024("embedding") });

  it("declares the pgvector column DDL type", () => {
    expect(testTable.embedding.getSQLType()).toBe("vector(1024)");
  });
  it("round-trips through the wire format", () => {
    const arr = [0.1, 0.2, 0.3];
    const wire = testTable.embedding.mapToDriverValue(arr) as string;
    expect(wire).toBe("[0.1,0.2,0.3]");
    expect(testTable.embedding.mapFromDriverValue(wire)).toEqual(arr);
  });
});
