import { type INestApplication } from "@nestjs/common";
import { APP_GUARD, APP_PIPE } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { ZodValidationPipe } from "nestjs-zod";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { applyGlobalConfig } from "../src/app/app-bootstrap";
import { AuthController } from "../src/modules/auth/auth.controller";
import { AuthService } from "../src/modules/auth/auth.service";
import { JwtAuthGuard } from "../src/modules/auth/jwt-auth.guard";
import { UsersService } from "../src/modules/users/users.service";
import { AppConfigService } from "../src/platform/config/config.service";

const SECRET = "test-secret-at-least-32-characters-long!!";

describe("global ZodValidationPipe", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: SECRET, signOptions: { expiresIn: "1h" } })],
      controllers: [AuthController],
      providers: [
        AuthService,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        { provide: UsersService, useValue: { validateCredentials: async () => null } },
        { provide: AppConfigService, useValue: { jwtExpiresIn: "1h", jwtSecret: SECRET } },
      ],
    }).compile();
    app = ref.createNestApplication();
    applyGlobalConfig(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects a malformed login body with 400 from ZodValidationPipe", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ email: "not-an-email" }) // password 缺失 + email 非法
      .expect(400);
    expect(res.body.message).toBe("Validation failed");
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.length).toBeGreaterThan(0);
  });

  it("lets a well-formed body reach the service (wrong credentials → 401, not 400)", async () => {
    await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ email: "demo@codecrush.local", password: "wrong" })
      .expect(401);
  });
});
