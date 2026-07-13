import { type INestApplication } from "@nestjs/common";
import { APP_GUARD, APP_PIPE } from "@nestjs/core";
import { ZodValidationPipe } from "nestjs-zod";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { applyGlobalConfig } from "../src/app/app-bootstrap";
import { TracesController } from "../src/modules/traces/traces.controller";
import { TracesService } from "../src/modules/traces/traces.service";
import { ClickHouseTracesRepository } from "../src/modules/traces/clickhouse-traces.repository";
import { CLICKHOUSE } from "../src/platform/clickhouse/clickhouse.constants";

// M9 W2 E2E：GET /traces/:traceId 经真实 controller→pipe→service→repository.buildMeta→契约序列化，
// 只把 ClickHouse 客户端 stub 成返回 canned span 行（root chain + reply llm），验证 meta 聚合与 statusMessage。

const HEX = "391dae938234560b16bb63f51501cb6f";

function fakeClickHouse(rows: unknown[]) {
  return {
    query: async ({ query }: { query: string }) => {
      if (query.startsWith("EXISTS TABLE")) return { json: async () => [{ result: 1 }] };
      return { json: async () => rows };
    },
    command: async () => {},
  };
}

describe("GET /traces/:traceId (M9 W2 e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      controllers: [TracesController],
      providers: [
        TracesService,
        ClickHouseTracesRepository,
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        // 放行鉴权，专注 traces 读路径
        { provide: APP_GUARD, useValue: { canActivate: () => true } },
        {
          provide: CLICKHOUSE,
          useValue: fakeClickHouse([
            {
              trace_id: HEX,
              span_id: "root".padEnd(16, "0"),
              parent_span_id: null,
              name: "rag.pipeline",
              kind: "chain",
              start_time: "2026-07-13 09:11:00.000",
              duration_ms: 2410,
              status_code: "Ok",
              status_message: "",
              attributes: {
                "codecrush.io.input": "怎么退款",
                "gen_ai.agent.name": "退款助手",
                "rag.prompt.version_id": "cv1",
                "rag.fallback.used": "false",
                "rag.quality.low_recall": "false",
                "rag.quality.no_citations": "false",
                "rag.quality.refusal": "false",
                "rag.quality.timeout": "false",
              },
            },
            {
              trace_id: HEX,
              span_id: "reply".padEnd(16, "0"),
              parent_span_id: "root".padEnd(16, "0"),
              name: "node.reply",
              kind: "llm",
              start_time: "2026-07-13 09:11:01.000",
              duration_ms: 1700,
              status_code: "Ok",
              status_message: "",
              attributes: {
                "rag.node.name": "reply",
                "gen_ai.request.model": "deepseek-v3",
                "gen_ai.usage.input_tokens": "1200",
                "gen_ai.usage.output_tokens": "200",
              },
            },
          ]),
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

  it("returns detail with assembled meta + spans[].statusMessage", async () => {
    const res = await request(app.getHttpServer()).get(`/api/traces/${HEX}`).expect(200);
    expect(res.body.meta).toMatchObject({
      userInput: "怎么退款",
      agentName: "退款助手",
      genModel: "deepseek-v3",
      genModelVersion: null,
      promptVersionId: "cv1",
      inputTokens: 1200,
      outputTokens: 200,
      cost: null,
      status: "success",
    });
    expect(Array.isArray(res.body.spans)).toBe(true);
    expect(res.body.spans[0]).toHaveProperty("statusMessage");
  });

  it("rejects a non-hex traceId with 400 before the service", async () => {
    await request(app.getHttpServer()).get("/api/traces/not-a-hex-id").expect(400);
  });
});
