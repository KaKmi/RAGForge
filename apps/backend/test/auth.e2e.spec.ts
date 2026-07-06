import { type INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import request from "supertest";
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
const profile = {
  id: "8f14e45f-ceea-467f-a8d5-91be1a2f3b6d",
  email: "demo@codecrush.local",
  displayName: "Demo Admin",
  status: "active",
  createdAt: "2026-07-05T00:00:00.000Z",
  updatedAt: "2026-07-05T00:00:00.000Z",
};

describe("global guard HTTP matrix", () => {
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
            validateCredentials: async (email: string, password: string) =>
              email === "demo@codecrush.local" && password === "CodeCrushDemo123!"
                ? profile
                : null,
            getProfile: async () => profile,
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
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /health 无 token → 200（@Public）", async () => {
    await request(app.getHttpServer()).get("/health").expect(200);
  });

  it("无 token：/users/me、/traces/hello、/traces/:id → 401", async () => {
    await request(app.getHttpServer()).get("/users/me").expect(401);
    await request(app.getHttpServer()).post("/traces/hello").expect(401);
    await request(app.getHttpServer())
      .get("/traces/391dae938234560b16bb63f51501cb6f")
      .expect(401);
  });

  it("坏 token → 401", async () => {
    await request(app.getHttpServer())
      .get("/users/me")
      .set("Authorization", "Bearer garbage")
      .expect(401);
  });

  it("登录矩阵：畸形 400 / 错凭据 401 / 正确 200", async () => {
    await request(app.getHttpServer()).post("/auth/login").send({ email: "nope" }).expect(400);
    await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: "demo@codecrush.local", password: "wrong" })
      .expect(401);
    const res = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: "demo@codecrush.local", password: "CodeCrushDemo123!" })
      .expect(200);
    expect(res.body.tokenType).toBe("Bearer");
    expect(res.body.user.email).toBe(profile.email);
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");

    await request(app.getHttpServer())
      .get("/users/me")
      .set("Authorization", `Bearer ${res.body.accessToken}`)
      .expect(200);
  });
});
