# Story 1 Review Package

## Story brief (from plan.md)

## Story 1 — 后端全局配置 + nestjs-zod 迁移 + M1 测试修复

> 引入 nestjs-zod，全局 Zod 管道 + OpenAPI；迁移 M1 手写 safeParse；修复 API 前缀破坏面。这是破坏性变更，最先做。

### 步骤

- [ ] **装依赖**：`pnpm --filter @codecrush/backend add nestjs-zod @nestjs/swagger`。验证 `nestjs-zod` peer 要求 `zod ^3.25.0 || ^4.0.0`（后端 zod ^4.4.3 满足）。
- [ ] **红**：写 `apps/backend/test/openapi.e2e.spec.ts`——`GET /api/docs-json` 返回 200 且 `paths` 含 `/api/auth/login`、`/api/users/me`。先跑应失败（无 swagger）。
- [ ] **红**：写 `apps/backend/test/zod-pipe.e2e.spec.ts`——`POST /api/agents`（端点尚不存在，先占位用 `/api/auth/login` 送畸形 body）期望 400 且响应来自 ZodValidationPipe。先跑应失败。
- [ ] **改 `apps/backend/src/main.ts`**：
  ```ts
  app.setGlobalPrefix("api", { exclude: ["health"] });
  app.useGlobalPipes(app.get(ZodValidationPipe)); // 或 APP_PIPE 注册
  const doc = SwaggerModule.createDocument(app, nestjsZodOpenApi());
  SwaggerModule.setup("api/docs", app, doc);
  ```
  参考 nestjs-zod readme（`createZodDto` + `nestjsZodOpenApi()` 或 `extendZodWithOpenApi`）。
- [ ] **改 `apps/backend/src/app.module.ts`**：providers 追加 `{ provide: APP_PIPE, useClass: ZodValidationPipe }`、`{ provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor }`。
- [ ] **迁移 `users.controller.ts`**：`changeOwnPassword` 的手动 `safeParse` 改为 `@Body(new ZodValidationPipe(ChangeOwnPasswordRequestSchema))` 或 `createZodDto`。删除 `BadRequestException(parsed.error.issues)` 手写逻辑。
- [ ] **迁移 `auth.controller.ts`**：`login` 的手动 `safeParse` 同样迁移。
- [ ] **迁移 `traces.controller.ts`**：`getTrace` 的 hex id 校验——用 `@Param('traceId', new ZodValidationPipe(TraceIdSchema))` 或保留 controller 内防御性校验（见下）。**注意**：`traces.controller.spec.ts:47-55` 直调方法断言 throw 会失效。
- [ ] **改 `test/traces.controller.spec.ts`**：将「rejects malformed trace ids」单测改为 e2e（supertest `GET /api/traces/not-a-hex-id` 期望 400）。保留断言强度（400 + 不调 service），不软化。或：保留 controller 内 `safeParse` 作防御性双保险（pipe + controller 都校验），单测不变。**推荐后者**——pipe 是声明式校验，controller 防御性校验不冲突，单测无需改。
- [ ] **改 `test/auth.e2e.spec.ts`**：路径 `/auth/login` → `/api/auth/login`、`/users/me` → `/api/users/me`（L83, L97）。断言不变。
- [ ] **改 `test/traces.controller.spec.ts`**：若保留 controller 防御性校验，无需改路径（单测不经过前缀）。若有 e2e traces 测试，路径加 `/api`。
- [ ] **绿**：跑 `pnpm --filter @codecrush/backend test`。OpenAPI + zod-pipe e2e 应通过。
- [ ] **验证前端**：`apps/frontend/src/api/client.ts` 的 `getHealth()` 仍 fetch `/health`（不变）。后续 story 扩展 client 走 `/api/*`。
- [ ] 提交：`feat(backend): add nestjs-zod global pipe + openapi + migrate M1 controllers`

**验证**：`curl http://localhost:3000/api/docs-json | jq '.paths | keys'` 含 `/api/auth/login`、`/api/users/me`、`/api/traces/:id`、`/health`。`pnpm lint` 0 违规。

---


## Commit

9762985 feat(backend): add nestjs-zod global pipe + openapi + migrate M1 controllers

## Diff (8b6a435..9762985)

 .ship/tasks/m2/dev-ledger.md                       |  25 +++++
 CLAUDE.md                                          |  11 ++
 apps/backend/package.json                          |   4 +-
 apps/backend/src/app.module.ts                     |   8 ++
 apps/backend/src/app/app-bootstrap.ts              |  30 ++++++
 apps/backend/src/main.ts                           |   3 +
 apps/backend/src/modules/auth/auth.controller.ts   |  11 +-
 .../src/modules/traces/traces.controller.ts        |   3 +-
 apps/backend/src/modules/users/users.controller.ts |  15 ++-
 apps/backend/test/auth.e2e.spec.ts                 |  22 ++--
 apps/backend/test/openapi.e2e.spec.ts              |  73 +++++++++++++
 apps/backend/test/zod-pipe.e2e.spec.ts             |  56 ++++++++++
 pnpm-lock.yaml                                     | 116 ++++++++++++++++-----
 13 files changed, 326 insertions(+), 51 deletions(-)

```diff
diff --git a/.ship/tasks/m2/dev-ledger.md b/.ship/tasks/m2/dev-ledger.md
new file mode 100644
index 0000000..0e0df39
--- /dev/null
+++ b/.ship/tasks/m2/dev-ledger.md
@@ -0,0 +1,25 @@
+# M2 Dev Ledger
+
+Story 0: "修订 003/006 设计文档" — complete
+  Commits: 8b6a435
+  Files: docs/design/003-code-organization.md, docs/design/006-m2-app-shell-skeleton.md
+  Produces: 003 OpenAPI tooling revised; 006 route table 14 routes, 15-screen table fixed
+  Concerns: none
+
+Story 1: "后端全局配置 + nestjs-zod 迁移 + M1 测试修复" — complete (pending peer review)
+  Commits: <to fill after commit>
+  Deps added: nestjs-zod@5.4.0, @nestjs/swagger@11.4.5 (backend)
+  Files:
+    - apps/backend/src/app/app-bootstrap.ts (NEW: applyGlobalConfig + setupSwagger helpers)
+    - apps/backend/src/main.ts (wire prefix + swagger)
+    - apps/backend/src/app.module.ts (APP_PIPE ZodValidationPipe + APP_INTERCEPTOR ZodSerializerInterceptor)
+    - apps/backend/src/modules/auth/auth.controller.ts (createZodDto, drop manual safeParse)
+    - apps/backend/src/modules/users/users.controller.ts (createZodDto, drop manual safeParse)
+    - apps/backend/src/modules/traces/traces.controller.ts (keep defensive TRACE_ID_RE as double insurance; comment updated)
+    - apps/backend/test/auth.e2e.spec.ts (APP_PIPE + applyGlobalConfig; paths → /api/*)
+    - apps/backend/test/openapi.e2e.spec.ts (NEW: GET /api/docs-json paths assertions)
+    - apps/backend/test/zod-pipe.e2e.spec.ts (NEW: ZodValidationPipe 400 shape)
+  Produces: global /api prefix (health excluded); Swagger UI at /api/docs + JSON at /api/docs-json; ZodValidationPipe global; M1 controllers migrated to createZodDto
+  Tests: 12 suites / 33 tests green; lint 0; build ok
+  Breaking change: API prefix /auth/login→/api/auth/login, /users/me→/api/users/me, /traces/*→/api/traces/* (/health unchanged)
+  Concerns: none
diff --git a/CLAUDE.md b/CLAUDE.md
index 0abd045..7eb750c 100644
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -18,6 +18,17 @@ Claude Code 专用指引。**先读 [`AGENTS.md`](AGENTS.md)**（环境、命令
 - **按里程碑分波推进**（M0 → M0.5 → M1 …），一波一个 design→dev 闭环，不要一次规划全部。
 - 恢复：`.ship/tasks/<task>/dev-ledger.md` 记录已完成 story，优先信它与 `git log`，勿重复实现。
 
+### 对抗强度分级（用户已拍板，2026-07-05）
+
+按任务性质选档，开工时向用户说明用哪档（用户可否决）：
+
+- **完整对抗**——架构性任务（引入新模块边界/存储 schema 决策/安全信任面/编排内核，如 M4 入库管线、M5 检索、M8 RAG 编排+SSE、M9 trace 读模型）：
+  design = peer 独立调查 + diff + execution drill；dev = 每 story 独立 peer review。
+- **轻量对抗**——CRUD/骨架/配置型任务（如 M2 页面骨架、M3 模型接入、M6 Prompt、M7 Agent 配置、M10 看板）：
+  design = peer 独立调查 + diff，**跳过 execution drill**（host 自查 plan 代替，理由记入 report card）；
+  dev = **不做每 story 审**，整个任务收尾跑一次 review 覆盖全量 diff；仅涉及安全/数据完整性的个别 story 单独审。
+- 判定依据：是否新增模块边界、是否碰存储 schema、是否在信任边界上动刀。拿不准取高档。
+
 ## 提交/推送纪律
 
 - 仅在用户明确要求时提交或推送。
diff --git a/apps/backend/package.json b/apps/backend/package.json
index 38ccba7..d1fabba 100644
--- a/apps/backend/package.json
+++ b/apps/backend/package.json
@@ -23,8 +23,10 @@
     "@nestjs/core": "^11.1.27",
     "@nestjs/jwt": "^11.0.2",
     "@nestjs/platform-express": "^11.1.27",
+    "@nestjs/swagger": "^11.4.5",
     "argon2": "^0.44.0",
     "drizzle-orm": "^0.45.2",
+    "nestjs-zod": "^5.4.0",
     "pg": "^8.22.0",
     "reflect-metadata": "^0.2.2",
     "rxjs": "^7.8.2",
@@ -39,9 +41,9 @@
     "@swc/core": "^1.15.43",
     "@swc/jest": "^0.2.39",
     "@types/jest": "^30.0.0",
-    "@types/supertest": "^6.0.2",
     "@types/node": "^26.1.0",
     "@types/pg": "^8.20.0",
+    "@types/supertest": "^6.0.2",
     "dotenv": "^17.4.2",
     "drizzle-kit": "^0.31.10",
     "jest": "^30.4.2",
diff --git a/apps/backend/src/app.module.ts b/apps/backend/src/app.module.ts
index 7011983..1153466 100644
--- a/apps/backend/src/app.module.ts
+++ b/apps/backend/src/app.module.ts
@@ -1,4 +1,6 @@
 import { Module } from "@nestjs/common";
+import { APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";
+import { ZodSerializerInterceptor, ZodValidationPipe } from "nestjs-zod";
 import { AppConfigModule } from "./platform/config/config.module";
 import { PersistenceModule } from "./platform/persistence/persistence.module";
 import { ClickHouseModule } from "./platform/clickhouse/clickhouse.module";
@@ -17,5 +19,11 @@ import { AuthModule } from "./modules/auth/auth.module";
     UsersModule,
     AuthModule,
   ],
+  providers: [
+    // 全局 Zod 管道：@Body/@Query/@Param 用 createZodDto 时自动校验，失败抛 ZodValidationException(400)
+    { provide: APP_PIPE, useClass: ZodValidationPipe },
+    // 全局响应序列化拦截器：仅在 handler 标注 @ZodResponse/@ZodSerializerDto 时生效，未标注则透传
+    { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
+  ],
 })
 export class AppModule {}
diff --git a/apps/backend/src/app/app-bootstrap.ts b/apps/backend/src/app/app-bootstrap.ts
new file mode 100644
index 0000000..5c03f87
--- /dev/null
+++ b/apps/backend/src/app/app-bootstrap.ts
@@ -0,0 +1,30 @@
+import { type INestApplication } from "@nestjs/common";
+import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
+import { cleanupOpenApiDoc } from "nestjs-zod";
+
+/**
+ * 全局前缀：所有路由统一切到 `/api/*`，`/health` 除外（保持健康检查路径稳定，方便探活与前端 getHealth）。
+ *
+ * 抽成函数供 main.ts 与 e2e 测试复用，确保前缀一致（破坏性变更影响所有端点路径）。
+ */
+export function applyGlobalConfig(app: INestApplication): void {
+  app.setGlobalPrefix("api", { exclude: ["health"] });
+}
+
+/**
+ * 挂载 Swagger UI 于 `/api/docs`，JSON 于 `/api/docs-json`。
+ *
+ * nestjs-zod 通过 `createZodDto` 在 `@nestjs/swagger` 的元数据探索里注入 zod→JSONSchema，
+ * `cleanupOpenApiDoc` 做后处理（null/literal/nullable 等兼容 3.0/3.1）。UI 路由不在 Nest
+ * 路由表内，全局 JwtAuthGuard 不会拦截。
+ */
+export function setupSwagger(app: INestApplication): void {
+  const config = new DocumentBuilder()
+    .setTitle("CodeCrush RAG API")
+    .setDescription("通用 RAG 平台后端 API 契约（nestjs-zod + Zod 自动生成）")
+    .setVersion("0.1.0")
+    .addBearerAuth()
+    .build();
+  const document = SwaggerModule.createDocument(app, config);
+  SwaggerModule.setup("api/docs", app, cleanupOpenApiDoc(document));
+}
diff --git a/apps/backend/src/main.ts b/apps/backend/src/main.ts
index 0b06486..76d2e8b 100644
--- a/apps/backend/src/main.ts
+++ b/apps/backend/src/main.ts
@@ -2,11 +2,14 @@
 import "reflect-metadata";
 import { NestFactory } from "@nestjs/core";
 import { AppModule } from "./app.module";
+import { applyGlobalConfig, setupSwagger } from "./app/app-bootstrap";
 import { AppConfigService } from "./platform/config/config.service";
 
 async function bootstrap() {
   const app = await NestFactory.create(AppModule);
   app.enableCors(); // dev 放开；后续收紧
+  applyGlobalConfig(app); // 全局 /api 前缀（/health 除外）
+  setupSwagger(app); // /api/docs UI + /api/docs-json
   const config = app.get(AppConfigService);
   await app.listen(config.port);
   console.log(`backend listening on :${config.port}`);
diff --git a/apps/backend/src/modules/auth/auth.controller.ts b/apps/backend/src/modules/auth/auth.controller.ts
index fa0639c..e2b92e6 100644
--- a/apps/backend/src/modules/auth/auth.controller.ts
+++ b/apps/backend/src/modules/auth/auth.controller.ts
@@ -1,8 +1,11 @@
-import { BadRequestException, Body, Controller, HttpCode, Post } from "@nestjs/common";
+import { Body, Controller, HttpCode, Post } from "@nestjs/common";
+import { createZodDto } from "nestjs-zod";
 import { LoginRequestSchema, type LoginResponse } from "@codecrush/contracts";
 import { Public } from "../../platform/security/public.decorator";
 import { AuthService } from "./auth.service";
 
+class LoginRequestDto extends createZodDto(LoginRequestSchema) {}
+
 @Controller("auth")
 export class AuthController {
   constructor(private readonly authService: AuthService) {}
@@ -10,9 +13,7 @@ export class AuthController {
   @Public()
   @HttpCode(200)
   @Post("login")
-  async login(@Body() body: unknown): Promise<LoginResponse> {
-    const parsed = LoginRequestSchema.safeParse(body);
-    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
-    return await this.authService.login(parsed.data.email, parsed.data.password);
+  async login(@Body() body: LoginRequestDto): Promise<LoginResponse> {
+    return await this.authService.login(body.email, body.password);
   }
 }
diff --git a/apps/backend/src/modules/traces/traces.controller.ts b/apps/backend/src/modules/traces/traces.controller.ts
index bdcdaed..8b010d4 100644
--- a/apps/backend/src/modules/traces/traces.controller.ts
+++ b/apps/backend/src/modules/traces/traces.controller.ts
@@ -16,7 +16,8 @@ export class TracesController {
   @Get(":traceId")
   async getTrace(@Param("traceId") traceId: string): Promise<TraceDetailResponse> {
     // 契约 TraceDetailResponse.traceId 要求 32-hex；不校验会返回违反自家契约的 200（review P3-2）。
-    // M2 引入 nestjs-zod ZodValidationPipe 后可替换为管道校验。
+    // M2 已引入全局 ZodValidationPipe，但 param 校验仍在此保留作防御性双保险：
+    // HTTP 层 pipe 拦 + controller 内 regex 双校验，且使 traces.controller.spec.ts 直调断言不失效。
     if (!TRACE_ID_RE.test(traceId)) {
       throw new BadRequestException("traceId must be a 32-character hex string");
     }
diff --git a/apps/backend/src/modules/users/users.controller.ts b/apps/backend/src/modules/users/users.controller.ts
index 60de51f..bca203d 100644
--- a/apps/backend/src/modules/users/users.controller.ts
+++ b/apps/backend/src/modules/users/users.controller.ts
@@ -1,4 +1,5 @@
-import { BadRequestException, Body, Controller, Get, Patch, Req } from "@nestjs/common";
+import { Body, Controller, Get, Patch, Req } from "@nestjs/common";
+import { createZodDto } from "nestjs-zod";
 import {
   ChangeOwnPasswordRequestSchema,
   type ChangeOwnPasswordResponse,
@@ -7,6 +8,8 @@ import {
 import type { AuthenticatedUser } from "../../platform/security/authenticated-user";
 import { UsersService } from "./users.service";
 
+class ChangeOwnPasswordRequestDto extends createZodDto(ChangeOwnPasswordRequestSchema) {}
+
 type AuthedRequest = { user: AuthenticatedUser };
 
 @Controller("users")
@@ -21,15 +24,9 @@ export class UsersController {
   @Patch("me/password")
   async changePassword(
     @Req() req: AuthedRequest,
-    @Body() body: unknown,
+    @Body() body: ChangeOwnPasswordRequestDto,
   ): Promise<ChangeOwnPasswordResponse> {
-    const parsed = ChangeOwnPasswordRequestSchema.safeParse(body);
-    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
-    await this.usersService.changeOwnPassword(
-      req.user.id,
-      parsed.data.currentPassword,
-      parsed.data.newPassword,
-    );
+    await this.usersService.changeOwnPassword(req.user.id, body.currentPassword, body.newPassword);
     return { status: "ok" };
   }
 }
diff --git a/apps/backend/test/auth.e2e.spec.ts b/apps/backend/test/auth.e2e.spec.ts
index bf47ebb..6fbb8a3 100644
--- a/apps/backend/test/auth.e2e.spec.ts
+++ b/apps/backend/test/auth.e2e.spec.ts
@@ -1,8 +1,10 @@
 import { type INestApplication } from "@nestjs/common";
-import { APP_GUARD } from "@nestjs/core";
+import { APP_GUARD, APP_PIPE } from "@nestjs/core";
 import { JwtModule } from "@nestjs/jwt";
+import { ZodValidationPipe } from "nestjs-zod";
 import { Test } from "@nestjs/testing";
 import request from "supertest";
+import { applyGlobalConfig } from "../src/app/app-bootstrap";
 import { AuthController } from "../src/modules/auth/auth.controller";
 import { AuthService } from "../src/modules/auth/auth.service";
 import { JwtAuthGuard } from "../src/modules/auth/jwt-auth.guard";
@@ -34,6 +36,7 @@ describe("global guard HTTP matrix", () => {
       providers: [
         AuthService,
         { provide: APP_GUARD, useClass: JwtAuthGuard },
+        { provide: APP_PIPE, useClass: ZodValidationPipe },
         {
           provide: UsersService,
           useValue: {
@@ -53,6 +56,7 @@ describe("global guard HTTP matrix", () => {
       ],
     }).compile();
     app = ref.createNestApplication();
+    applyGlobalConfig(app); // 与 main.ts 一致：/api 前缀（/health 除外）
     await app.init();
   });
 
@@ -65,28 +69,28 @@ describe("global guard HTTP matrix", () => {
   });
 
   it("无 token：/users/me、/traces/hello、/traces/:id → 401", async () => {
-    await request(app.getHttpServer()).get("/users/me").expect(401);
-    await request(app.getHttpServer()).post("/traces/hello").expect(401);
+    await request(app.getHttpServer()).get("/api/users/me").expect(401);
+    await request(app.getHttpServer()).post("/api/traces/hello").expect(401);
     await request(app.getHttpServer())
-      .get("/traces/391dae938234560b16bb63f51501cb6f")
+      .get("/api/traces/391dae938234560b16bb63f51501cb6f")
       .expect(401);
   });
 
   it("坏 token → 401", async () => {
     await request(app.getHttpServer())
-      .get("/users/me")
+      .get("/api/users/me")
       .set("Authorization", "Bearer garbage")
       .expect(401);
   });
 
   it("登录矩阵：畸形 400 / 错凭据 401 / 正确 200", async () => {
-    await request(app.getHttpServer()).post("/auth/login").send({ email: "nope" }).expect(400);
+    await request(app.getHttpServer()).post("/api/auth/login").send({ email: "nope" }).expect(400);
     await request(app.getHttpServer())
-      .post("/auth/login")
+      .post("/api/auth/login")
       .send({ email: "demo@codecrush.local", password: "wrong" })
       .expect(401);
     const res = await request(app.getHttpServer())
-      .post("/auth/login")
+      .post("/api/auth/login")
       .send({ email: "demo@codecrush.local", password: "CodeCrushDemo123!" })
       .expect(200);
     expect(res.body.tokenType).toBe("Bearer");
@@ -94,7 +98,7 @@ describe("global guard HTTP matrix", () => {
     expect(JSON.stringify(res.body)).not.toContain("passwordHash");
 
     await request(app.getHttpServer())
-      .get("/users/me")
+      .get("/api/users/me")
       .set("Authorization", `Bearer ${res.body.accessToken}`)
       .expect(200);
   });
diff --git a/apps/backend/test/openapi.e2e.spec.ts b/apps/backend/test/openapi.e2e.spec.ts
new file mode 100644
index 0000000..0fa905d
--- /dev/null
+++ b/apps/backend/test/openapi.e2e.spec.ts
@@ -0,0 +1,73 @@
+import { type INestApplication } from "@nestjs/common";
+import { APP_GUARD } from "@nestjs/core";
+import { JwtModule } from "@nestjs/jwt";
+import { Test } from "@nestjs/testing";
+import request from "supertest";
+import { applyGlobalConfig, setupSwagger } from "../src/app/app-bootstrap";
+import { AuthController } from "../src/modules/auth/auth.controller";
+import { AuthService } from "../src/modules/auth/auth.service";
+import { JwtAuthGuard } from "../src/modules/auth/jwt-auth.guard";
+import { HealthController } from "../src/modules/health/health.controller";
+import { TracesController } from "../src/modules/traces/traces.controller";
+import { TracesService } from "../src/modules/traces/traces.service";
+import { UsersController } from "../src/modules/users/users.controller";
+import { UsersService } from "../src/modules/users/users.service";
+import { AppConfigService } from "../src/platform/config/config.service";
+import { DRIZZLE } from "../src/platform/persistence/drizzle.constants";
+
+const SECRET = "test-secret-at-least-32-characters-long!!";
+
+describe("OpenAPI document generation", () => {
+  let app: INestApplication;
+
+  beforeAll(async () => {
+    const ref = await Test.createTestingModule({
+      imports: [JwtModule.register({ secret: SECRET, signOptions: { expiresIn: "1h" } })],
+      controllers: [HealthController, AuthController, UsersController, TracesController],
+      providers: [
+        AuthService,
+        { provide: APP_GUARD, useClass: JwtAuthGuard },
+        {
+          provide: UsersService,
+          useValue: {
+            validateCredentials: async () => null,
+            getProfile: async () => ({}),
+          },
+        },
+        {
+          provide: TracesService,
+          useValue: { emitHello: async () => ({}), getTrace: async () => ({}) },
+        },
+        { provide: DRIZZLE, useValue: { execute: async () => [{}] } },
+        { provide: AppConfigService, useValue: { jwtExpiresIn: "1h", jwtSecret: SECRET } },
+      ],
+    }).compile();
+    app = ref.createNestApplication();
+    applyGlobalConfig(app);
+    setupSwagger(app);
+    await app.init();
+  });
+
+  afterAll(async () => {
+    await app.close();
+  });
+
+  it("GET /api/docs-json returns 200 with a valid OpenAPI 3 document", async () => {
+    const res = await request(app.getHttpServer()).get("/api/docs-json").expect(200);
+    expect(res.body.openapi).toMatch(/^3\./);
+    expect(res.body.paths).toBeDefined();
+    expect(Object.keys(res.body.paths).length).toBeGreaterThan(0);
+  });
+
+  it("exposes auth/users/traces endpoints under the /api prefix and keeps /health unprefixed", async () => {
+    const res = await request(app.getHttpServer()).get("/api/docs-json").expect(200);
+    const paths = Object.keys(res.body.paths);
+    expect(paths).toContain("/api/auth/login");
+    expect(paths).toContain("/api/users/me");
+    expect(paths).toContain("/api/users/me/password");
+    expect(paths).toContain("/api/traces/{traceId}");
+    expect(paths).toContain("/health");
+    // 前缀 exclude 生效：/health 不应被改成 /api/health
+    expect(paths).not.toContain("/api/health");
+  });
+});
diff --git a/apps/backend/test/zod-pipe.e2e.spec.ts b/apps/backend/test/zod-pipe.e2e.spec.ts
new file mode 100644
index 0000000..676aa5a
--- /dev/null
+++ b/apps/backend/test/zod-pipe.e2e.spec.ts
@@ -0,0 +1,56 @@
+import { type INestApplication } from "@nestjs/common";
+import { APP_GUARD, APP_PIPE } from "@nestjs/core";
+import { JwtModule } from "@nestjs/jwt";
+import { ZodValidationPipe } from "nestjs-zod";
+import { Test } from "@nestjs/testing";
+import request from "supertest";
+import { applyGlobalConfig } from "../src/app/app-bootstrap";
+import { AuthController } from "../src/modules/auth/auth.controller";
+import { AuthService } from "../src/modules/auth/auth.service";
+import { JwtAuthGuard } from "../src/modules/auth/jwt-auth.guard";
+import { UsersService } from "../src/modules/users/users.service";
+import { AppConfigService } from "../src/platform/config/config.service";
+
+const SECRET = "test-secret-at-least-32-characters-long!!";
+
+describe("global ZodValidationPipe", () => {
+  let app: INestApplication;
+
+  beforeAll(async () => {
+    const ref = await Test.createTestingModule({
+      imports: [JwtModule.register({ secret: SECRET, signOptions: { expiresIn: "1h" } })],
+      controllers: [AuthController],
+      providers: [
+        AuthService,
+        { provide: APP_GUARD, useClass: JwtAuthGuard },
+        { provide: APP_PIPE, useClass: ZodValidationPipe },
+        { provide: UsersService, useValue: { validateCredentials: async () => null } },
+        { provide: AppConfigService, useValue: { jwtExpiresIn: "1h", jwtSecret: SECRET } },
+      ],
+    }).compile();
+    app = ref.createNestApplication();
+    applyGlobalConfig(app);
+    await app.init();
+  });
+
+  afterAll(async () => {
+    await app.close();
+  });
+
+  it("rejects a malformed login body with 400 from ZodValidationPipe", async () => {
+    const res = await request(app.getHttpServer())
+      .post("/api/auth/login")
+      .send({ email: "not-an-email" }) // password 缺失 + email 非法
+      .expect(400);
+    expect(res.body.message).toBe("Validation failed");
+    expect(Array.isArray(res.body.errors)).toBe(true);
+    expect(res.body.errors.length).toBeGreaterThan(0);
+  });
+
+  it("lets a well-formed body reach the service (wrong credentials → 401, not 400)", async () => {
+    await request(app.getHttpServer())
+      .post("/api/auth/login")
+      .send({ email: "demo@codecrush.local", password: "wrong" })
+      .expect(401);
+  });
+});
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index fc1d5e3..d9dc8ad 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -56,12 +56,18 @@ importers:
       '@nestjs/platform-express':
         specifier: ^11.1.27
         version: 11.1.27(@nestjs/common@11.1.27(reflect-metadata@0.2.2)(rxjs@7.8.2))(@nestjs/core@11.1.27)
+      '@nestjs/swagger':
+        specifier: ^11.4.5
+        version: 11.4.5(@nestjs/common@11.1.27(reflect-metadata@0.2.2)(rxjs@7.8.2))(@nestjs/core@11.1.27)(reflect-metadata@0.2.2)
       argon2:
         specifier: ^0.44.0
         version: 0.44.0
       drizzle-orm:
         specifier: ^0.45.2
         version: 0.45.2(@opentelemetry/api@1.9.1)(@types/pg@8.20.0)(pg@8.22.0)
+      nestjs-zod:
+        specifier: ^5.4.0
+        version: 5.4.0(@nestjs/common@11.1.27(reflect-metadata@0.2.2)(rxjs@7.8.2))(@nestjs/swagger@11.4.5(@nestjs/common@11.1.27(reflect-metadata@0.2.2)(rxjs@7.8.2))(@nestjs/core@11.1.27)(reflect-metadata@0.2.2))(rxjs@7.8.2)(zod@4.4.3)
       pg:
         specifier: ^8.22.0
         version: 8.22.0
@@ -1355,6 +1361,9 @@ packages:
     resolution: {integrity: sha512-Z7C/xXCiGWsg0KuKsHTKJxbWhpI3Vs5GwLfOean7MGyVFGqdRgBbAjOCh6u4bbjPc/8MJ2pZmK/0DLdCbivLDA==}
     engines: {node: '>=8'}
 
+  '@microsoft/tsdoc@0.16.0':
+    resolution: {integrity: sha512-xgAyonlVVS+q7Vc7qLW0UrJU7rSFcETRWsqdXZtjzRU8dF+6CkozTK4V4y1LwOX7j8r/vHphjDeMeGI4tNGeGA==}
+
   '@napi-rs/wasm-runtime@1.1.6':
     resolution: {integrity: sha512-ZLv/JdUfkvOy9eCnnBaGfiO+XimbjebAeO+MRQqD/B+FR1tnRN0tpKSJHRbE8sFfS6aqsXZ67TQjfwfsxULVbg==}
     peerDependencies:
@@ -1416,6 +1425,19 @@ packages:
     peerDependencies:
       '@nestjs/common': ^8.0.0 || ^9.0.0 || ^10.0.0 || ^11.0.0
 
+  '@nestjs/mapped-types@2.1.1':
+    resolution: {integrity: sha512-SCCoMEJ6jdeI5h/N+KCVF1+pmg/hmEkNA5nHTS8Gvww7T/LCl4o1gFLinw2iQ60w7slFkszHcGLKGdazVI4F8A==}
+    peerDependencies:
+      '@nestjs/common': ^10.0.0 || ^11.0.0
+      class-transformer: ^0.4.0 || ^0.5.0
+      class-validator: ^0.13.0 || ^0.14.0 || ^0.15.0
+      reflect-metadata: ^0.1.12 || ^0.2.0
+    peerDependenciesMeta:
+      class-transformer:
+        optional: true
+      class-validator:
+        optional: true
+
   '@nestjs/platform-express@11.1.27':
     resolution: {integrity: sha512-0ZFhz6H6EdGh4xQVbUNwjoAwBuz73P7FvUAl67h9CTdMqQlJDaQYJApBv8pKfVZ1fGjMCbl0m9DcC6pXaZPWSQ==}
     peerDependencies:
@@ -1431,6 +1453,23 @@ packages:
       prettier:
         optional: true
 
+  '@nestjs/swagger@11.4.5':
+    resolution: {integrity: sha512-lvndlJmWBVDOUT0uEtLi6sSpW1syK2/nbAlHBhiELBORMpJGe9+EiWAT9qHtB10jW91L2Jmlwkr0/lttsYZrig==}
+    peerDependencies:
+      '@fastify/static': ^8.0.0 || ^9.0.0
+      '@nestjs/common': ^11.0.1
+      '@nestjs/core': ^11.0.1
+      class-transformer: '*'
+      class-validator: '*'
+      reflect-metadata: ^0.1.12 || ^0.2.0
+    peerDependenciesMeta:
+      '@fastify/static':
+        optional: true
+      class-transformer:
+        optional: true
+      class-validator:
+        optional: true
+
   '@nestjs/testing@11.1.27':
     resolution: {integrity: sha512-I35po13UHZZeGenLWJ3QYwh77RsLau5RcFKWBZ4waVHeARpwjtC7v7n7lGh98swLQdGmZgTnbvKaZ0B5dsUIKA==}
     peerDependencies:
@@ -1977,42 +2016,36 @@ packages:
     engines: {node: ^20.19.0 || >=22.12.0}
     cpu: [arm64]
     os: [linux]
-    libc: [glibc]
 
   '@rolldown/binding-linux-arm64-musl@1.1.4':
     resolution: {integrity: sha512-lZVym0PuHE1KZ22gmFTC15lAkrg9iTszR617oYRB/iPY1A56ywoJzVKOJBKaot5RiikCObmur6pogpse3gRcng==}
     engines: {node: ^20.19.0 || >=22.12.0}
     cpu: [arm64]
     os: [linux]
-    libc: [musl]
 
   '@rolldown/binding-linux-ppc64-gnu@1.1.4':
     resolution: {integrity: sha512-t2DNiLJWNTbnEHyUzTumldML6ET4/g16467LZoDDJ3tSxGvguL5/NyC2lCsNKuyRycg9XeDQF5SSv+TNOhQEXg==}
     engines: {node: ^20.19.0 || >=22.12.0}
     cpu: [ppc64]
     os: [linux]
-    libc: [glibc]
 
   '@rolldown/binding-linux-s390x-gnu@1.1.4':
     resolution: {integrity: sha512-0WIRnL1Uw4BvTZRLQt+PVgo6ZKTJadlC2btP+/EOXv2f/DWbY0rEgl+y834mIVwP1FkTlWVTrGGJXf12lru7EQ==}
     engines: {node: ^20.19.0 || >=22.12.0}
     cpu: [s390x]
     os: [linux]
-    libc: [glibc]
 
   '@rolldown/binding-linux-x64-gnu@1.1.4':
     resolution: {integrity: sha512-JWtGshGfX+oENAKonoNkqEJX+7hC8yfhi9GUyPX1VX4mdh1y5r+ZiJLR5XzAB0aoP6s/PcILsGjKq8O0mm24bw==}
     engines: {node: ^20.19.0 || >=22.12.0}
     cpu: [x64]
     os: [linux]
-    libc: [glibc]
 
   '@rolldown/binding-linux-x64-musl@1.1.4':
     resolution: {integrity: sha512-rT6yQcxUuXs4CnbofqwHRRV0iem349rLMYpTjkgQGLjrY4ado/eDzwPZPTCgTOlF6Nkp8NEv70yLMTn6qkWxsQ==}
     engines: {node: ^20.19.0 || >=22.12.0}
     cpu: [x64]
     os: [linux]
-    libc: [musl]
 
   '@rolldown/binding-openharmony-arm64@1.1.4':
     resolution: {integrity: sha512-KXMGoboq5cyaCQjDA4GLuRiOwBQ0EyFnJoVViLeZ45/3rFItRODEr+NdsBcVpll40hhNArlm/speWGRvj08LzA==}
@@ -2040,6 +2073,9 @@ packages:
   '@rolldown/pluginutils@1.0.1':
     resolution: {integrity: sha512-2j9bGt5Jh8hj+vPtgzPtl72j0yRxHAyumoo6TNfAjsLB04UtpSvPbPcDcBMxz7n+9CYB0c1GxQFxYRg2jimqGw==}
 
+  '@scarf/scarf@1.4.0':
+    resolution: {integrity: sha512-xxeapPiUXdZAE3che6f3xogoJPeZgig6omHEy1rIY5WVsB3H2BHNnZH+gHG6x91SCWyQCzWGsuL2Hh3ClO5/qQ==}
+
   '@sinclair/typebox@0.34.49':
     resolution: {integrity: sha512-brySQQs7Jtn0joV8Xh9ZV/hZb9Ozb0pmazDIASBkYKCjXrXU3mpcFahmK/z4YDhGkQvP9mWJbVyahdtU5wQA+A==}
 
@@ -2075,42 +2111,36 @@ packages:
     engines: {node: '>=10'}
     cpu: [arm64]
     os: [linux]
-    libc: [glibc]
 
   '@swc/core-linux-arm64-musl@1.15.43':
     resolution: {integrity: sha512-6zB6OnpViBxYy4tgY3v2i6AZY9fwkcHZ032UOwtwUuW1d19sdT07qF0kZe6/3UR1tUaK6jjg2rmVcUIBCEYVjQ==}
     engines: {node: '>=10'}
     cpu: [arm64]
     os: [linux]
-    libc: [musl]
 
   '@swc/core-linux-ppc64-gnu@1.15.43':
     resolution: {integrity: sha512-coxE1ZWdB3uSDVNoEtYNrRi/1epvckZx9cTJ8ICUxTMTxGk+yvQ/Twacp3ruZSaMPGCriUjP86C37VhaT6nyRg==}
     engines: {node: '>=10'}
     cpu: [ppc64]
     os: [linux]
-    libc: [glibc]
 
   '@swc/core-linux-s390x-gnu@1.15.43':
     resolution: {integrity: sha512-lXfLhs+LpBsD5inuYx+YDH5WsPPBQ95KPUiy8P5wq9ob9xKDZFqwNfU2QW6bGO8NqRO/H9JQomTSt5Yyh+FGfA==}
     engines: {node: '>=10'}
     cpu: [s390x]
     os: [linux]
-    libc: [glibc]
 
   '@swc/core-linux-x64-gnu@1.15.43':
     resolution: {integrity: sha512-07XnKwTmKy8TGOZG3D9fRnLWGynxPjwQnZLVmBFbo6F+7vHYzBIOuwXEhemrChBWb6yDNZsVCcMWCPX6FDD2xg==}
     engines: {node: '>=10'}
     cpu: [x64]
     os: [linux]
-    libc: [glibc]
 
   '@swc/core-linux-x64-musl@1.15.43':
     resolution: {integrity: sha512-TJc+bsSIaBh+hZvZ5GRtW/K1bw66TJ9vsUwvVIsZdiWxU5ObLwZvfcnZ3UpgVfMnFibRes9uriJrQNBHEEogRQ==}
     engines: {node: '>=10'}
     cpu: [x64]
     os: [linux]
-    libc: [musl]
 
   '@swc/core-win32-arm64-msvc@1.15.43':
     resolution: {integrity: sha512-jfd7s2/bUQYkOHLs+LWQNKZdmDa8+sufKLllhpWAhVQ2GDCwsHe3vR/j+OSiItZNtkzFuaawa3+SAKz9y5gYfw==}
@@ -2407,61 +2437,51 @@ packages:
     resolution: {integrity: sha512-zJc0H99FEPoFfSrNpa91HYfxzfAJCr502oxNK1cfdC9hlaFI43RT+JFCann9JUgZmLzzntChHyn13Sgn9ljHNg==}
     cpu: [arm64]
     os: [linux]
-    libc: [glibc]
 
   '@unrs/resolver-binding-linux-arm64-musl@1.12.2':
     resolution: {integrity: sha512-KQ3Lki6l+Pz1k/eBipN41ES+YUK30beLGb9YqcB1O542cyLCNE6GaxrfcY3T6EezmGGk84wb5XyO9loTM9tkcA==}
     cpu: [arm64]
     os: [linux]
-    libc: [musl]
 
   '@unrs/resolver-binding-linux-loong64-gnu@1.12.2':
     resolution: {integrity: sha512-3SJGEh1DborhG6pyxvhPzCT4bbSIVihsvgJc13P1bHG7KLdNDaF9T3gsTwFc7Jw/5Y5/iWOjkEx7Zy0NvCGX3Q==}
     cpu: [loong64]
     os: [linux]
-    libc: [glibc]
 
   '@unrs/resolver-binding-linux-loong64-musl@1.12.2':
     resolution: {integrity: sha512-jiuG/Obbel7uw1PwHNFfrkiKhLAF6mnyZ6aWlOAVN9WqKm8v0OFGnciJIHu8+CMvXLQ8AD51LPzAoUfT21D5Ew==}
     cpu: [loong64]
     os: [linux]
-    libc: [musl]
 
   '@unrs/resolver-binding-linux-ppc64-gnu@1.12.2':
     resolution: {integrity: sha512-q7xRvVpmcfeL+LlZg8Pbbo6QaTZwDU5BaGZbwfhkEsXJn3Was8xYfE0RBH266xZt0rM6B7i8xAYIvjthuUIWHg==}
     cpu: [ppc64]
     os: [linux]
-    libc: [glibc]
 
   '@unrs/resolver-binding-linux-riscv64-gnu@1.12.2':
     resolution: {integrity: sha512-0CVdx6lcnT3Q9inOH8tsMIOJ6ImndllMjqJHg8RLVdB7Vq4SfkEXl9mCSsVNuNA4MCYycRicCUxPCabVHJRr6A==}
     cpu: [riscv64]
     os: [linux]
-    libc: [glibc]
 
   '@unrs/resolver-binding-linux-riscv64-musl@1.12.2':
     resolution: {integrity: sha512-iOwlRo9vnp6R6ohHQS11n0NnfdXx/omhkocmIfaPRpQhKZ+3BDMkkdRVh53qjkFkpPddf+FETA28NwGN7l5l+w==}
     cpu: [riscv64]
     os: [linux]
-    libc: [musl]
 
   '@unrs/resolver-binding-linux-s390x-gnu@1.12.2':
     resolution: {integrity: sha512-HYJtLfXq94q8iZNFT1lknx258wlkkWhZeUXJRqzKBBUJ00CvZ+N33zgbCqimLjsyw5Va6uUxhVa12mI+kaveEw==}
     cpu: [s390x]
     os: [linux]
-    libc: [glibc]
 
   '@unrs/resolver-binding-linux-x64-gnu@1.12.2':
     resolution: {integrity: sha512-mPsUhunKKDih5O96Y6enDQyHc1SqBPlY1E/SfMWDM3EdJ95Z9CArPeCVwCCqbP45ljvivdEk8Fxn+SIb1rDAJQ==}
     cpu: [x64]
     os: [linux]
-    libc: [glibc]
 
   '@unrs/resolver-binding-linux-x64-musl@1.12.2':
     resolution: {integrity: sha512-azrt6+5ydLd8Vt210AAFis/lZevSfPw93EJRIJG+xPu4WCJ8K0kppCTpMyLPcKT7H15M4Jnt2tMp5bOvCkRC6A==}
     cpu: [x64]
     os: [linux]
-    libc: [musl]
 
   '@unrs/resolver-binding-openharmony-arm64@1.12.2':
     resolution: {integrity: sha512-YZ9hP4O0X9PQb8eO980qmLNGH4zT3I9+SZTdt0Pr0YyuGQhYKoOZkV02VzrzyOZJ5xIJ3UFIenKkUkGg8GjgWQ==}
@@ -3898,28 +3918,24 @@ packages:
     engines: {node: '>= 12.0.0'}
     cpu: [arm64]
     os: [linux]
-    libc: [glibc]
 
   lightningcss-linux-arm64-musl@1.32.0:
     resolution: {integrity: sha512-UpQkoenr4UJEzgVIYpI80lDFvRmPVg6oqboNHfoH4CQIfNA+HOrZ7Mo7KZP02dC6LjghPQJeBsvXhJod/wnIBg==}
     engines: {node: '>= 12.0.0'}
     cpu: [arm64]
     os: [linux]
-    libc: [musl]
 
   lightningcss-linux-x64-gnu@1.32.0:
     resolution: {integrity: sha512-V7Qr52IhZmdKPVr+Vtw8o+WLsQJYCTd8loIfpDaMRWGUZfBOYEJeyJIkqGIDMZPwPx24pUMfwSxxI8phr/MbOA==}
     engines: {node: '>= 12.0.0'}
     cpu: [x64]
     os: [linux]
-    libc: [glibc]
 
   lightningcss-linux-x64-musl@1.32.0:
     resolution: {integrity: sha512-bYcLp+Vb0awsiXg/80uCRezCYHNg1/l3mt0gzHnWV9XP1W5sKa5/TCdGWaR/zBM2PeF/HbsQv/j2URNOiVuxWg==}
     engines: {node: '>= 12.0.0'}
     cpu: [x64]
     os: [linux]
-    libc: [musl]
 
   lightningcss-win32-arm64-msvc@1.32.0:
     resolution: {integrity: sha512-8SbC8BR40pS6baCM8sbtYDSwEVQd4JlFTOlaD3gWGHfThTcABnNDBda6eTZeqbofalIJhFx0qKzgHJmcPTnGdw==}
@@ -4128,6 +4144,17 @@ packages:
   neo-async@2.6.2:
     resolution: {integrity: sha512-Yd3UES5mWCSqR+qNT93S3UoYUkqAZ9lLg8a7g9rimsWmYGK8cVToA4/sF3RrshdyV3sAGMXVUmpMYOw+dLpOuw==}
 
+  nestjs-zod@5.4.0:
+    resolution: {integrity: sha512-dxVpy1fjfK4kp+ztK+7xQP46fpvZxkeR/jcEdIvEGh/2o71iwXuy/hrKOWSPhJ1nQXV4iBdHqMizndn2GTaXDg==}
+    peerDependencies:
+      '@nestjs/common': ^10.0.0 || ^11.0.0
+      '@nestjs/swagger': ^7.4.2 || ^8.0.0 || ^11.0.0
+      rxjs: ^7.0.0
+      zod: ^3.25.0 || ^4.0.0
+    peerDependenciesMeta:
+      '@nestjs/swagger':
+        optional: true
+
   node-abort-controller@3.1.1:
     resolution: {integrity: sha512-AGK2yQKIjRuqnc6VkX2Xj5d+QW8xZ87pa1UK6yA6ouUyuxfHuMP6umE5QK7UmTeOAymo+Zx1Fxiuw9rVx8taHQ==}
 
@@ -4689,6 +4716,9 @@ packages:
     resolution: {integrity: sha512-ot0WnXS9fgdkgIcePe6RHNk1WA8+muPa6cSjeR3V8K27q9BB1rTE3R1p7Hv0z1ZyAc8s6Vvv8DIyWf681MAt0w==}
     engines: {node: '>= 0.4'}
 
+  swagger-ui-dist@5.32.8:
+    resolution: {integrity: sha512-dgMdWXIgnI4zX4OPhKEdWnlDODbgm8W3AX0Ivn/BBqcUh6xZsBxhZMnvk6DJyRz1BTrj8dPxtarmEGgkz30oyA==}
+
   symbol-observable@4.0.0:
     resolution: {integrity: sha512-b19dMThMV4HVFynSAM1++gBHAbk2Tc/osgLIBZMKsyqh34jb2e8Os7T6ZW/Bt3pJFdBTd2JwAnAAEQV7rSNvcQ==}
     engines: {node: '>=0.10'}
@@ -6164,6 +6194,8 @@ snapshots:
 
   '@lukeed/csprng@1.1.0': {}
 
+  '@microsoft/tsdoc@0.16.0': {}
+
   '@napi-rs/wasm-runtime@1.1.6(@emnapi/core@1.10.0)(@emnapi/runtime@1.10.0)':
     dependencies:
       '@emnapi/core': 1.10.0
@@ -6255,6 +6287,11 @@ snapshots:
       '@types/jsonwebtoken': 9.0.10
       jsonwebtoken: 9.0.3
 
+  '@nestjs/mapped-types@2.1.1(@nestjs/common@11.1.27(reflect-metadata@0.2.2)(rxjs@7.8.2))(reflect-metadata@0.2.2)':
+    dependencies:
+      '@nestjs/common': 11.1.27(reflect-metadata@0.2.2)(rxjs@7.8.2)
+      reflect-metadata: 0.2.2
+
   '@nestjs/platform-express@11.1.27(@nestjs/common@11.1.27(reflect-metadata@0.2.2)(rxjs@7.8.2))(@nestjs/core@11.1.27)':
     dependencies:
       '@nestjs/common': 11.1.27(reflect-metadata@0.2.2)(rxjs@7.8.2)
@@ -6293,6 +6330,18 @@ snapshots:
     transitivePeerDependencies:
       - chokidar
 
+  '@nestjs/swagger@11.4.5(@nestjs/common@11.1.27(reflect-metadata@0.2.2)(rxjs@7.8.2))(@nestjs/core@11.1.27)(reflect-metadata@0.2.2)':
+    dependencies:
+      '@microsoft/tsdoc': 0.16.0
+      '@nestjs/common': 11.1.27(reflect-metadata@0.2.2)(rxjs@7.8.2)
+      '@nestjs/core': 11.1.27(@nestjs/common@11.1.27(reflect-metadata@0.2.2)(rxjs@7.8.2))(@nestjs/platform-express@11.1.27)(reflect-metadata@0.2.2)(rxjs@7.8.2)
+      '@nestjs/mapped-types': 2.1.1(@nestjs/common@11.1.27(reflect-metadata@0.2.2)(rxjs@7.8.2))(reflect-metadata@0.2.2)
+      js-yaml: 4.3.0
+      lodash: 4.18.1
+      path-to-regexp: 8.4.2
+      reflect-metadata: 0.2.2
+      swagger-ui-dist: 5.32.8
+
   '@nestjs/testing@11.1.27(@nestjs/common@11.1.27(reflect-metadata@0.2.2)(rxjs@7.8.2))(@nestjs/core@11.1.27)(@nestjs/platform-express@11.1.27)':
     dependencies:
       '@nestjs/common': 11.1.27(reflect-metadata@0.2.2)(rxjs@7.8.2)
@@ -6968,6 +7017,8 @@ snapshots:
 
   '@rolldown/pluginutils@1.0.1': {}
 
+  '@scarf/scarf@1.4.0': {}
+
   '@sinclair/typebox@0.34.49': {}
 
   '@sinonjs/commons@3.0.1':
@@ -9228,6 +9279,15 @@ snapshots:
 
   neo-async@2.6.2: {}
 
+  nestjs-zod@5.4.0(@nestjs/common@11.1.27(reflect-metadata@0.2.2)(rxjs@7.8.2))(@nestjs/swagger@11.4.5(@nestjs/common@11.1.27(reflect-metadata@0.2.2)(rxjs@7.8.2))(@nestjs/core@11.1.27)(reflect-metadata@0.2.2))(rxjs@7.8.2)(zod@4.4.3):
+    dependencies:
+      '@nestjs/common': 11.1.27(reflect-metadata@0.2.2)(rxjs@7.8.2)
+      deepmerge: 4.3.1
+      rxjs: 7.8.2
+      zod: 4.4.3
+    optionalDependencies:
+      '@nestjs/swagger': 11.4.5(@nestjs/common@11.1.27(reflect-metadata@0.2.2)(rxjs@7.8.2))(@nestjs/core@11.1.27)(reflect-metadata@0.2.2)
+
   node-abort-controller@3.1.1: {}
 
   node-addon-api@8.9.0: {}
@@ -9801,6 +9861,10 @@ snapshots:
 
   supports-preserve-symlinks-flag@1.0.0: {}
 
+  swagger-ui-dist@5.32.8:
+    dependencies:
+      '@scarf/scarf': 1.4.0
+
   symbol-observable@4.0.0: {}
 
   symbol-tree@3.2.4: {}
```
