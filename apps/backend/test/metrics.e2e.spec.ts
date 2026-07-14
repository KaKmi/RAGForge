import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { applyGlobalConfig } from "../src/app/app-bootstrap";
import { ClickHouseMetricsRepository } from "../src/modules/traces/clickhouse-metrics.repository";
import { MetricsController } from "../src/modules/traces/metrics.controller";

const overview = {
  window: {
    qaCount: 1,
    failCount: 0,
    failRate: 0,
    fallbackCount: 0,
    fallbackRate: 0,
    lowRecallCount: 0,
    noCiteCount: 0,
    refusalCount: 0,
    timeoutCount: 0,
    p50Ms: 100,
    p95Ms: 100,
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0,
  },
  series: [],
};

describe("metrics endpoints", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      controllers: [MetricsController],
      providers: [
        {
          provide: ClickHouseMetricsRepository,
          useValue: {
            getOverview: jest.fn(async () => overview),
            getAppMetrics: jest.fn(async () => overview),
          },
        },
      ],
    }).compile();
    app = ref.createNestApplication();
    applyGlobalConfig(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /metrics/overview 返回 window+series", async () => {
    const res = await request(app.getHttpServer()).get(
      "/api/metrics/overview?from=2026-07-01T00:00:00Z&to=2026-07-14T00:00:00Z",
    );
    expect(res.status).toBe(200);
    expect(res.body.window).toBeDefined();
    expect(Array.isArray(res.body.series)).toBe(true);
  });

  it("GET /metrics/overview 非法 from → 400", async () => {
    const res = await request(app.getHttpServer()).get("/api/metrics/overview?from=nope");
    expect(res.status).toBe(400);
  });

  it("GET /metrics/apps/:id 限定应用", async () => {
    const res = await request(app.getHttpServer()).get("/api/metrics/apps/app-1");
    expect(res.status).toBe(200);
  });
});
