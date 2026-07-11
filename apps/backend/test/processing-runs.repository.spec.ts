import { isActiveRunConflict } from "../src/modules/ingestion/processing-runs.repository";

describe("isActiveRunConflict", () => {
  const pgError = Object.assign(new Error("duplicate key"), {
    code: "23505",
    constraint: "dpr_active_doc_unique",
  });

  it("识别 DrizzleQueryError cause 中的活动 Run 唯一约束冲突", () => {
    const wrapped = Object.assign(new Error("Failed query"), { cause: pgError });
    expect(isActiveRunConflict(wrapped)).toBe(true);
  });

  it("识别裸 pg 唯一约束错误", () => {
    expect(isActiveRunConflict(pgError)).toBe(true);
  });

  it("拒绝其他错误码、其他约束与普通错误", () => {
    expect(isActiveRunConflict(new Error("boom"))).toBe(false);
    expect(
      isActiveRunConflict(
        Object.assign(new Error("duplicate key"), { code: "23505", constraint: "other" }),
      ),
    ).toBe(false);
    expect(isActiveRunConflict(Object.assign(new Error("wrapped"), { cause: new Error("inner") }))).toBe(
      false,
    );
  });
});
