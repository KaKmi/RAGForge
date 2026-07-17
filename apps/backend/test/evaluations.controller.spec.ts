import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { applyGlobalConfig } from "../src/app/app-bootstrap";
import { EvaluationsController } from "../src/modules/evaluations/evaluations.controller";
import { EvaluationsService } from "../src/modules/evaluations/evaluations.service";

const overviewFixture = {
  meta: {
    enabled: false,
    sampleRate: 0.1,
    evaluatedCount: 0,
    eligibleCount: 0,
    evaluableCount: 0,
    judgeModel: null,
    judgeVersion: "online-v1",
    status: "disabled" as const,
    backlog: 0,
  },
  metrics: {
    faithfulness: { value: null, previousDelta: null, sampleCount: 0, threshold: 85, low: false },
    answerRelevancy: { value: null, previousDelta: null, sampleCount: 0, threshold: 80, low: false },
    contextPrecision: { value: null, previousDelta: null, sampleCount: 0, threshold: 80, low: false },
  },
  trend: [],
  byAgent: [],
  lowSamples: [],
};

const settingsFixture = {
  settings: {
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
  },
  models: { judges: [], embeddings: [] },
};

describe("EvaluationsController", () => {
  let app: INestApplication;
  const service = {
    getOverview: jest.fn(),
    getTraceQuality: jest.fn(),
    getSettings: jest.fn(),
    updateSettings: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [EvaluationsController],
      providers: [{ provide: EvaluationsService, useValue: service }],
    }).compile();
    app = moduleRef.createNestApplication();
    applyGlobalConfig(app);
    await app.init();
  });

  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => app.close());

  it("returns 400 for a window longer than 30 days", async () => {
    await request(app.getHttpServer())
      .get("/api/eval/quality/overview")
      .query({ from: "2026-05-01T00:00:00.000Z", to: "2026-07-15T00:00:00.000Z" })
      .expect(400);
    expect(service.getOverview).not.toHaveBeenCalled();
  });

  it("exposes all four quality control-plane routes", async () => {
    service.getOverview.mockResolvedValue(overviewFixture);
    service.getTraceQuality.mockResolvedValue({ status: "unscored" });
    service.getSettings.mockResolvedValue(settingsFixture);
    service.updateSettings.mockResolvedValue(settingsFixture);

    await request(app.getHttpServer()).get("/api/eval/quality/overview").expect(200);
    await request(app.getHttpServer())
      .get(`/api/eval/quality/traces/${"a".repeat(32)}`)
      .expect(200);
    await request(app.getHttpServer()).get("/api/eval/quality/settings").expect(200);
    await request(app.getHttpServer())
      .put("/api/eval/quality/settings")
      .send({ enabled: false })
      .expect(200);
  });

  it("rejects malformed trace ids and invalid settings bodies", async () => {
    await request(app.getHttpServer()).get("/api/eval/quality/traces/not-a-trace").expect(400);
    await request(app.getHttpServer())
      .put("/api/eval/quality/settings")
      .send({ sampleRate: 2 })
      .expect(400);
  });
});
