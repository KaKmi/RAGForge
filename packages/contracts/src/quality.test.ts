import { describe, expect, it } from "vitest";
import {
  OnlineEvalSettingsSchema,
  OnlineEvalSettingsResponseSchema,
  QualityOverviewQuerySchema,
  QualityOverviewResponseSchema,
  TraceQualityDetailSchema,
  UpdateOnlineEvalSettingsRequestSchema,
} from "./quality";

const scored = {
  status: "scored",
  scores: { faithfulness: 91, answerRelevancy: 82, contextPrecision: 76 },
  thresholds: { faithfulness: 85, answerRelevancy: 80, contextPrecision: 80 },
  judgeModel: "qwen-plus",
  judgeVersion: "online-v1",
  scoredAt: "2026-07-15T02:00:00.000Z",
  currentVersion: true,
  evidence: {
    faithfulness: ["2/2 claims supported"],
    answerRelevancy: ["generated question matches intent"],
    contextPrecision: ["relevant chunks at ranks 1 and 3"],
  },
} as const;

describe("online quality contracts", () => {
  it("accepts scored/unscored/failed detail states", () => {
    expect(TraceQualityDetailSchema.parse(scored).status).toBe("scored");
    expect(TraceQualityDetailSchema.parse({ status: "unscored" }).status).toBe("unscored");
    expect(
      TraceQualityDetailSchema.parse({
        status: "failed",
        judgeVersion: "online-v1",
        failedAt: "2026-07-15T02:00:00.000Z",
        reason: "judge output invalid",
        currentVersion: true,
      }).status,
    ).toBe("failed");
  });

  it("rejects scores and evidence outside bounds", () => {
    expect(
      TraceQualityDetailSchema.safeParse({
        ...scored,
        scores: { ...scored.scores, faithfulness: 101 },
      }).success,
    ).toBe(false);
    expect(
      TraceQualityDetailSchema.safeParse({
        ...scored,
        evidence: { ...scored.evidence, faithfulness: ["x".repeat(301)] },
      }).success,
    ).toBe(false);
  });

  it("limits the requested window", () => {
    expect(QualityOverviewQuerySchema.safeParse({}).success).toBe(true);
    expect(
      QualityOverviewQuerySchema.safeParse({
        from: "2026-07-01T00:00:00.000Z",
        to: "2026-07-15T00:00:00.000Z",
        agentId: "app-1",
      }).success,
    ).toBe(true);
    expect(
      QualityOverviewQuerySchema.safeParse({
        from: "2026-05-01T00:00:00.000Z",
        to: "2026-07-15T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("accepts the trend and low-sample shapes consumed by the quality page", () => {
    const base = {
      meta: {
        enabled: true,
        sampleRate: 0.1,
        evaluatedCount: 1,
        eligibleCount: 10,
        evaluableCount: 2,
        judgeModel: "qwen-plus",
        judgeVersion: "online-v1",
        status: "healthy",
        backlog: 0,
      },
      metrics: {
        faithfulness: { value: 70, previousDelta: null, sampleCount: 1, threshold: 85, low: true },
        answerRelevancy: {
          value: 80,
          previousDelta: null,
          sampleCount: 1,
          threshold: 80,
          low: false,
        },
        contextPrecision: {
          value: 90,
          previousDelta: null,
          sampleCount: 1,
          threshold: 80,
          low: false,
        },
      },
      trend: [
        {
          bucket: "2026-07-15T01:00:00.000Z",
          faithfulness: 70,
          answerRelevancy: 80,
          contextPrecision: 90,
          sampleCount: 9,
          insufficientSample: true,
        },
      ],
      byAgent: [],
      lowSamples: [
        {
          targetTraceId: "a".repeat(32),
          question: "退款多久",
          minMetric: "faithfulness",
          minScore: 70,
          evidenceSummary: "第二条主张缺少依据",
        },
      ],
    };
    expect(QualityOverviewResponseSchema.safeParse(base).success).toBe(true);
  });

  it("rejects a daily cap above the operational limit", () => {
    expect(UpdateOnlineEvalSettingsRequestSchema.safeParse({ dailyCap: 10_001 }).success).toBe(
      false,
    );
  });

  it("requires both model ids before enabling", () => {
    expect(
      UpdateOnlineEvalSettingsRequestSchema.safeParse({ enabled: true, judgeModelId: "m1" })
        .success,
    ).toBe(false);
  });

  it("accepts a complete overview including null small-sample delta", () => {
    const response = {
      meta: {
        enabled: true,
        sampleRate: 0.1,
        evaluatedCount: 12,
        eligibleCount: 100,
        evaluableCount: 40,
        judgeModel: "qwen-plus",
        judgeVersion: "online-v1",
        status: "healthy",
        backlog: 3,
      },
      metrics: {
        faithfulness: {
          value: 91,
          previousDelta: null,
          sampleCount: 12,
          threshold: 85,
          low: false,
        },
        answerRelevancy: {
          value: 82,
          previousDelta: null,
          sampleCount: 12,
          threshold: 80,
          low: false,
        },
        contextPrecision: {
          value: 76,
          previousDelta: null,
          sampleCount: 12,
          threshold: 80,
          low: true,
        },
      },
      trend: [],
      byAgent: [],
      lowSamples: [],
    };
    expect(QualityOverviewResponseSchema.safeParse(response).success).toBe(true);
  });

  it("settings defaults are represented by the contract", () => {
    const value = OnlineEvalSettingsSchema.parse({
      id: "default",
      enabled: false,
      sampleRate: 0.1,
      judgeModelId: null,
      embeddingModelId: null,
      faithfulnessThreshold: 85,
      answerRelevancyThreshold: 80,
      contextPrecisionThreshold: 80,
      dailyCap: 500,
      judgeVersion: "online-v1",
      updatedAt: "2026-07-15T02:00:00.000Z",
    });
    expect(value.dailyCap).toBe(500);
  });

  it("returns typed model choices including unavailable selections", () => {
    const parsed = OnlineEvalSettingsResponseSchema.parse({
      settings: {
        id: "default",
        enabled: false,
        sampleRate: 0.1,
        judgeModelId: "judge-old",
        embeddingModelId: "embed-1",
        faithfulnessThreshold: 85,
        answerRelevancyThreshold: 80,
        contextPrecisionThreshold: 80,
        dailyCap: 500,
        judgeVersion: "online-v1",
        updatedAt: "2026-07-15T02:00:00.000Z",
      },
      models: {
        judges: [{ id: "judge-old", name: "Old Judge", enabled: false, available: false }],
        embeddings: [{ id: "embed-1", name: "Embed 1", enabled: true, available: true }],
      },
    });
    expect(parsed.models.judges[0]?.available).toBe(false);
  });
});
