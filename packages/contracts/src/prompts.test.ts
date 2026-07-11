import { describe, it, expect } from "vitest";
import { ValidateStepSchema, TryRunResultSchema } from "./prompts";

// M8.0 Story 8：TryRunResultSchema 的 structured 分支从占位类型改为真实 Schema
// （validateSteps 从 z.array(z.unknown()) 收紧为 ValidateStepSchema 数组）。

describe("ValidateStepSchema", () => {
  it("合法 step 通过", () => {
    expect(ValidateStepSchema.safeParse({ step: "output_schema", ok: true }).success).toBe(true);
  });
  it("六种合法 step 枚举值全部通过（含 M8.0 node-runtime executor round 1/2 review 新增的 reserved）", () => {
    for (const step of ["input", "reserved", "output_schema", "extra_validate", "repair", "fallback"]) {
      expect(ValidateStepSchema.safeParse({ step, ok: true }).success).toBe(true);
    }
  });
  it("非法 step 枚举拒绝", () => {
    expect(ValidateStepSchema.safeParse({ step: "not_a_step", ok: true }).success).toBe(false);
  });
  it("issues 字段可选，提供时必须是字符串数组", () => {
    expect(ValidateStepSchema.safeParse({ step: "input", ok: false, issues: ["a", "b"] }).success).toBe(
      true,
    );
    expect(ValidateStepSchema.safeParse({ step: "input", ok: false, issues: [1, 2] }).success).toBe(
      false,
    );
  });
});

describe("TryRunResultSchema · structured 分支", () => {
  it("正例：fields/validateSteps/fallbackUsed 齐全", () => {
    const r = TryRunResultSchema.safeParse({
      mode: "structured",
      fields: { rewrittenQuery: "x", keywords: [] },
      validateSteps: [{ step: "input", ok: true }],
      fallbackUsed: false,
    });
    expect(r.success).toBe(true);
  });
  it("validateSteps 里出现非法 step 值 → 整体拒绝（不再是 z.unknown() 照单全收）", () => {
    const r = TryRunResultSchema.safeParse({
      mode: "structured",
      fields: {},
      validateSteps: [{ step: "not_a_real_step", ok: true }],
      fallbackUsed: false,
    });
    expect(r.success).toBe(false);
  });
  it("text/unavailable 分支不受影响（既有契约回归）", () => {
    expect(TryRunResultSchema.safeParse({ mode: "text", text: "x" }).success).toBe(true);
    expect(
      TryRunResultSchema.safeParse({ mode: "unavailable", reason: "pending_node_runtime" }).success,
    ).toBe(true);
    expect(
      TryRunResultSchema.safeParse({ mode: "unavailable", reason: "unsupported_protocol" }).success,
    ).toBe(true);
  });
});
