import { describe, expect, it } from "vitest";
import {
  CreateEvalSetRequestSchema,
  UpdateEvalSetRequestSchema,
  CreateEvalCaseRequestSchema,
  ImportEvalCasesRequestSchema,
} from "./eval-sets";

describe("CreateEvalSetRequestSchema", () => {
  it("accepts a 1-50 char name", () => {
    expect(CreateEvalSetRequestSchema.parse({ name: "售后核心 50 题" }).name).toBe("售后核心 50 题");
  });
  it("rejects empty and >50 char names", () => {
    expect(CreateEvalSetRequestSchema.safeParse({ name: "" }).success).toBe(false);
    expect(CreateEvalSetRequestSchema.safeParse({ name: "x".repeat(51) }).success).toBe(false);
  });
  it("rejects a whitespace-only name（§19.1「请输入名称」）", () => {
    expect(CreateEvalSetRequestSchema.safeParse({ name: "   " }).success).toBe(false);
  });
});

describe("UpdateEvalSetRequestSchema", () => {
  // 回归护栏：曾用 CreateEvalSetRequestSchema.partial()，但 .partial() 不去掉 kbIds 的
  // .default([]) → 一次纯改名会把关联知识库清空。此测试钉死 PATCH 的「只改传了的字段」语义。
  it("omitting kbIds must NOT reset it（纯改名不得清空关联知识库）", () => {
    const parsed = UpdateEvalSetRequestSchema.parse({ name: "新名字" });
    expect("kbIds" in parsed).toBe(false);
  });
  it("an empty patch stays empty", () => {
    expect(UpdateEvalSetRequestSchema.parse({})).toEqual({});
  });
  it("still validates the fields that ARE supplied", () => {
    expect(UpdateEvalSetRequestSchema.safeParse({ name: "x".repeat(51) }).success).toBe(false);
  });
});

describe("CreateEvalCaseRequestSchema", () => {
  it("accepts a case without gold points (draft)", () => {
    const parsed = CreateEvalCaseRequestSchema.parse({ question: "课程可以退款吗" });
    expect(parsed.goldPoints).toEqual([]);
  });
  it("rejects question >500 chars", () => {
    expect(CreateEvalCaseRequestSchema.safeParse({ question: "x".repeat(501) }).success).toBe(false);
  });
  it("rejects a gold point >200 chars", () => {
    expect(
      CreateEvalCaseRequestSchema.safeParse({ question: "q", goldPoints: ["x".repeat(201)] }).success,
    ).toBe(false);
  });
  it("rejects >10 gold docs and >5 tags", () => {
    expect(
      CreateEvalCaseRequestSchema.safeParse({
        question: "q",
        goldDocIds: Array.from({ length: 11 }, () => "11111111-1111-4111-8111-111111111111"),
      }).success,
    ).toBe(false);
    expect(
      CreateEvalCaseRequestSchema.safeParse({ question: "q", tags: ["a", "b", "c", "d", "e", "f"] })
        .success,
    ).toBe(false);
  });
  it("rejects a tag longer than 12 chars", () => {
    expect(
      CreateEvalCaseRequestSchema.safeParse({ question: "q", tags: ["x".repeat(13)] }).success,
    ).toBe(false);
  });
});

describe("ImportEvalCasesRequestSchema", () => {
  // 原型 §17.2：「>1000 行**整批拒**」——这一条归 DTO。
  it("rejects more than 1000 rows（整批拒）", () => {
    const rows = Array.from({ length: 1001 }, () => ({ question: "q", goldAnswer: "a" }));
    expect(ImportEvalCasesRequestSchema.safeParse({ rows }).success).toBe(false);
  });
  it("accepts exactly 1000 rows", () => {
    const rows = Array.from({ length: 1000 }, () => ({ question: "q", goldAnswer: "a" }));
    expect(ImportEvalCasesRequestSchema.safeParse({ rows }).success).toBe(true);
  });

  // 原型 §17.2：「缺 question/gold_answer **该行拒**」——归 service 的逐行回执，DTO 必须放行，
  // 否则整批 400、用户拿不到「第 N 行缺少 gold_answer」。回归护栏：曾写 .min(1) 造成整批拒。
  it("lets rows with a missing gold_answer THROUGH（该行拒由 service 出回执，不在此整批拒）", () => {
    const parsed = ImportEvalCasesRequestSchema.safeParse({
      rows: [
        { question: "q1", goldAnswer: "a1" },
        { question: "q2", goldAnswer: "" },
      ],
    });
    expect(parsed.success).toBe(true);
  });
  it("lets rows with a missing question THROUGH（同上）", () => {
    expect(
      ImportEvalCasesRequestSchema.safeParse({ rows: [{ question: "", goldAnswer: "a" }] }).success,
    ).toBe(true);
  });
  it("lets an over-length question THROUGH（500 字上限是逐行业务规则，不是整批拒）", () => {
    expect(
      ImportEvalCasesRequestSchema.safeParse({
        rows: [{ question: "x".repeat(501), goldAnswer: "a" }],
      }).success,
    ).toBe(true);
  });
  it("still guards against absurd payloads（DoS 兜底，远高于业务上限）", () => {
    expect(
      ImportEvalCasesRequestSchema.safeParse({
        rows: [{ question: "x".repeat(2001), goldAnswer: "a" }],
      }).success,
    ).toBe(false);
  });
});
