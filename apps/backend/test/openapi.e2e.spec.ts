import { type INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { applyGlobalConfig, setupSwagger } from "../src/app/app-bootstrap";
import { AuthController } from "../src/modules/auth/auth.controller";
import { AuthService } from "../src/modules/auth/auth.service";
import { JwtAuthGuard } from "../src/modules/auth/jwt-auth.guard";
import { HealthController } from "../src/modules/health/health.controller";
import { TracesController } from "../src/modules/traces/traces.controller";
import { TracesService } from "../src/modules/traces/traces.service";
import { UsersController } from "../src/modules/users/users.controller";
import { UsersService } from "../src/modules/users/users.service";
import { AppConfigService } from "../src/platform/config/config.service";
import { DRIZZLE } from "../src/platform/persistence/drizzle.constants";

const SECRET = "test-secret-at-least-32-characters-long!!";

describe("OpenAPI document generation", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: SECRET, signOptions: { expiresIn: "1h" } })],
      controllers: [HealthController, AuthController, UsersController, TracesController],
      providers: [
        AuthService,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        {
          provide: UsersService,
          useValue: {
            validateCredentials: async () => null,
            getProfile: async () => ({}),
          },
        },
        {
          provide: TracesService,
          useValue: { emitHello: async () => ({}), getTrace: async () => ({}) },
        },
        { provide: DRIZZLE, useValue: { execute: async () => [{}] } },
        { provide: AppConfigService, useValue: { jwtExpiresIn: "1h", jwtSecret: SECRET } },
      ],
    }).compile();
    app = ref.createNestApplication();
    applyGlobalConfig(app);
    setupSwagger(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/docs-json returns 200 with a valid OpenAPI 3 document", async () => {
    const res = await request(app.getHttpServer()).get("/api/docs-json").expect(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(res.body.paths).toBeDefined();
    expect(Object.keys(res.body.paths).length).toBeGreaterThan(0);
  });

  it("exposes auth/users/traces endpoints under the /api prefix and keeps /health unprefixed", async () => {
    const res = await request(app.getHttpServer()).get("/api/docs-json").expect(200);
    const paths = Object.keys(res.body.paths);
    expect(paths).toContain("/api/auth/login");
    expect(paths).toContain("/api/users/me");
    expect(paths).toContain("/api/users/me/password");
    expect(paths).toContain("/api/traces/{traceId}");
    expect(paths).toContain("/health");
    // 前缀 exclude 生效：/health 不应被改成 /api/health
    expect(paths).not.toContain("/api/health");
  });
});
