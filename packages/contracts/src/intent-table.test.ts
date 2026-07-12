import { describe, expect, it } from "vitest";
import {
  CHAT_INTENT_KEY,
  INTENT_OUTPUT_KEYS,
  INTENT_TABLE,
  IntentKeySchema,
  UNKNOWN_INTENT_KEY,
} from "./intent-table";
import {
  CreateKnowledgeBaseRequestSchema,
  KnowledgeBaseSchema,
  UpdateKnowledgeBaseRequestSchema,
} from "./knowledge-bases";

describe("意图表常量（014 D1）", () => {
  it("INTENT_TABLE 每项含 key/label/criteria（小分类判断锚点）", () => {
    expect(INTENT_TABLE.length).toBeGreaterThan(0);
    for (const c of INTENT_TABLE) {
      expect(c.key).toMatch(/^[A-Z_]+$/);
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.criteria.length).toBeGreaterThan(0);
    }
  });

  it("INTENT_OUTPUT_KEYS = 全表 ∪ CHAT ∪ UNKNOWN", () => {
    expect(INTENT_OUTPUT_KEYS).toEqual([
      ...INTENT_TABLE.map((c) => c.key),
      CHAT_INTENT_KEY,
      UNKNOWN_INTENT_KEY,
    ]);
    expect(INTENT_OUTPUT_KEYS).toEqual(
      expect.arrayContaining(["SUPPORT", CHAT_INTENT_KEY, UNKNOWN_INTENT_KEY]),
    );
  });

  it("IntentKeySchema（KB 可绑值域）只含业务 key，排除 CHAT/UNKNOWN", () => {
    expect(() => IntentKeySchema.parse("SUPPORT")).not.toThrow();
    expect(() => IntentKeySchema.parse("FEEDBACK")).not.toThrow();
    expect(() => IntentKeySchema.parse(CHAT_INTENT_KEY)).toThrow();
    expect(() => IntentKeySchema.parse(UNKNOWN_INTENT_KEY)).toThrow();
    expect(() => IntentKeySchema.parse("bogus")).toThrow();
  });
});

describe("KB 契约 intentKey（014 D2）", () => {
  const baseKb = {
    id: "kb1",
    name: "售后库",
    desc: "",
    chunkTemplate: "general",
    embeddingModelId: "m1",
    docsCount: 0,
    chunksCount: 0,
    status: "ready",
    activeVersion: 1,
    buildingVersion: null,
    processingProfileId: null,
    processingProfileVersion: null,
    updatedAt: new Date().toISOString(),
  };

  it("KnowledgeBase 响应带 intentKey（可 null=未绑定通配）", () => {
    expect(KnowledgeBaseSchema.parse({ ...baseKb, intentKey: "SUPPORT" }).intentKey).toBe(
      "SUPPORT",
    );
    expect(KnowledgeBaseSchema.parse({ ...baseKb, intentKey: null }).intentKey).toBeNull();
  });

  it("Update strictObject：{intentKey:'SUPPORT'} 合法、{intentKey:null} 解绑合法、CHAT 抛", () => {
    expect(() => UpdateKnowledgeBaseRequestSchema.parse({ intentKey: "SUPPORT" })).not.toThrow();
    expect(() => UpdateKnowledgeBaseRequestSchema.parse({ intentKey: null })).not.toThrow();
    expect(() => UpdateKnowledgeBaseRequestSchema.parse({ intentKey: "CHAT" })).toThrow();
    expect(() => UpdateKnowledgeBaseRequestSchema.parse({ intentKey: "UNKNOWN" })).toThrow();
  });

  it("Create 可携 intentKey（可省略）", () => {
    const base = { name: "n", desc: "", chunkTemplate: "general", embeddingModelId: "m1" };
    expect(() => CreateKnowledgeBaseRequestSchema.parse(base)).not.toThrow();
    expect(
      CreateKnowledgeBaseRequestSchema.parse({ ...base, intentKey: "FEEDBACK" }).intentKey,
    ).toBe("FEEDBACK");
    expect(() => CreateKnowledgeBaseRequestSchema.parse({ ...base, intentKey: "CHAT" })).toThrow();
  });
});
