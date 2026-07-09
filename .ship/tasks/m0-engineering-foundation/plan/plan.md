# Plan — M0 工程地基脚手架

- **Task ID**: m0-engineering-foundation
- **Spec**: 见同目录 `spec.md`（含 §9 已应用补丁）
- **执行顺序**: Story 0 → 6，严格依赖有序（root → contracts → infra → backend → frontend → 验收）
- **版本策略**: 用 `pnpm add` 拉当前版本，不硬编码次版本；已知需锁的镜像标签在步骤内注明。
- **约定**: npm scope `@codecrush/*`；workspace 引用 `workspace:*`；Node 22。

> 每个 Story 结束都可独立验证。带 🧪 的步骤是"先写测试（红）→ 再实现（绿）"的 TDD 顺序。

---

## Story 0 — 仓库与 workspace 根

- [ ] **0.1** 初始化 git + Node 版本

```bash
cd /Users/zhaopengcheng/Desktop/rag-service
git init
corepack enable
corepack prepare pnpm@latest --activate
node -v   # 期望 v22.x；不是则先装 Node 22
```

- [ ] **0.2** 写 `.nvmrc`

```
22
```

- [ ] **0.3** 写 `.gitignore`

```gitignore
node_modules/
dist/
.turbo/
*.log
.env
.env.*
!.env.example
coverage/
.DS_Store
```

- [ ] **0.4** 写根 `package.json`

```json
{
  "name": "@codecrush/root",
  "private": true,
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "eslint .",
    "format": "prettier --write .",
    "db:generate": "pnpm --filter @codecrush/backend db:generate",
    "db:migrate": "pnpm --filter @codecrush/backend db:migrate"
  }
}
```

- [ ] **0.5** 写 `pnpm-workspace.yaml`

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **0.6** 写 `turbo.json`（turbo 2.x 用 `tasks`；`dev` 持久不缓存 — D6）

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["^build"] },
    "dev": { "dependsOn": ["^build"], "cache": false, "persistent": true }
  }
}
```

- [ ] **0.7** 安装根开发依赖

```bash
pnpm add -w -D turbo typescript prettier eslint typescript-eslint eslint-config-prettier
```

**验证 Story 0**: `pnpm -v` 正常，`ls package.json pnpm-workspace.yaml turbo.json` 存在。

---

## Story 1 — 根 tooling（tsconfig / eslint / prettier）

- [ ] **1.1** 写 `tsconfig.base.json`（仅共享严格项；module/jsx 由各 app 覆盖）

```json
{
  "compilerOptions": {
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true
  }
}
```

- [ ] **1.2** 写 `.prettierrc`

```json
{ "semi": true, "singleQuote": false, "printWidth": 100, "trailingComma": "all" }
```

- [ ] **1.3** 写根 `eslint.config.mjs`（flat；D2：用内置 `no-restricted-imports` 落两条硬边界，零解析器坑；完整 boundaries 延到 M1）

```js
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "apps/backend/drizzle/**",
      "**/*.config.*",
    ],
  },
  // 让 ESLint 9 flat config 处理 .ts/.tsx（默认只处理 .js/.mjs/.cjs）
  { files: ["**/*.{ts,tsx}"] },
  ...tseslint.configs.recommended,
  // Boundary ①：frontend 不得 import backend（仅可用 @codecrush/contracts）
  {
    files: ["apps/frontend/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@codecrush/backend", "@codecrush/backend/*"],
              message: "frontend 只能用 @codecrush/contracts，不得 import backend",
            },
          ],
        },
      ],
    },
  },
  // Boundary ②：contracts 是地基，不得依赖任何 app
  {
    files: ["packages/contracts/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@codecrush/backend", "@codecrush/frontend"],
              message: "contracts 是地基，不得依赖 apps",
            },
          ],
        },
      ],
    },
  },
  prettier,
);
```

**验证 Story 1**: `pnpm lint`（此刻无源码，应 0 error 退出）。

---

## Story 2 — `packages/contracts`（Zod 契约源 + OTLP 常量）

- [ ] **2.1** 先写 `packages/contracts/package.json`（**必须先带 scoped name，再装依赖** —— 否则 `pnpm init` 会把包名设成目录名 "contracts"，后续 `--filter @codecrush/contracts` 匹配不到。CommonJS 产物，backend 原生 require、frontend Vite 也可消费，见 spec §7）

```json
{
  "name": "@codecrush/contracts",
  "version": "0.0.0",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  }
}
```

- [ ] **2.2** 建 src 目录并装依赖（`pnpm add` 把版本写回上面的 package.json）

```bash
mkdir -p packages/contracts/src
pnpm --filter @codecrush/contracts add zod
pnpm --filter @codecrush/contracts add -D typescript vitest
```

- [ ] **2.3** 写 `packages/contracts/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "CommonJS",
    "moduleResolution": "Node",
    "target": "ES2021",
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "exclude": ["**/*.test.ts"]
}
```

- [ ] 🧪 **2.4** 先写测试 `packages/contracts/src/health.test.ts`（红）

```ts
import { describe, it, expect } from "vitest";
import { HealthResponseSchema } from "./health";

describe("HealthResponseSchema", () => {
  it("accepts an ok result", () => {
    const r = HealthResponseSchema.safeParse({
      status: "ok",
      db: "up",
      details: { db: { status: "up" } },
    });
    expect(r.success).toBe(true);
  });
  it("rejects invalid status", () => {
    expect(HealthResponseSchema.safeParse({ status: "green", db: "up" }).success).toBe(false);
  });
});
```

- [ ] **2.5** 写 `packages/contracts/src/health.ts`（绿）

```ts
import { z } from "zod";

export const HealthResponseSchema = z.object({
  status: z.enum(["ok", "error"]),
  db: z.enum(["up", "down"]),
  details: z.record(z.string(), z.object({ status: z.string() })).optional(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
```

- [ ] **2.6** 写 `packages/contracts/src/otel.ts`（OTLP 属性 key 常量，前后端共用 — 为 M0.5/M8 预备）

```ts
/** OpenTelemetry GenAI 语义约定 key（M0.5+ 埋点使用） */
export const GEN_AI = {
  SYSTEM: "gen_ai.system",
  REQUEST_MODEL: "gen_ai.request.model",
  USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
} as const;

/** RAG 专有 span 属性 key */
export const RAG = {
  RETRIEVAL_TOP_K: "rag.retrieval.top_k",
  CHUNK_SCORES: "rag.chunk.scores",
  CITATION_IDS: "rag.citation.ids",
  COST_USD: "rag.cost.usd",
  PROMPT_VERSION_ID: "rag.prompt.version_id",
} as const;
```

- [ ] **2.7** 写 `packages/contracts/src/index.ts`

```ts
export * from "./health";
export * from "./otel";
```

- [ ] **2.8** 构建 + 测试

```bash
pnpm --filter @codecrush/contracts build
pnpm --filter @codecrush/contracts test
```

**验证 Story 2**: 测试全绿；`packages/contracts/dist/index.js` 与 `index.d.ts` 生成。

---

## Story 3 — `infra`（docker-compose infra profile）

- [ ] **3.1** 写 `infra/postgres/init.sql`（装 pgvector 扩展，供 M4；D5）

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

- [ ] **3.2** 写 `infra/collector/config.yaml`（M0 最小：OTLP 收 → debug 出；不接 CH，留 M0.5）

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
processors:
  batch: {}
exporters:
  debug:
    verbosity: normal
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [debug]
```

- [ ] **3.3** 建 ClickHouse init 目录占位（读 VIEW 留 M0.5）

```bash
mkdir -p infra/clickhouse/init && touch infra/clickhouse/init/.gitkeep
```

- [ ] **3.4** 写 `infra/docker-compose.yml`（D5 用 pgvector 镜像；CH/Collector 仅定义不接线；镜像标签 M0 用 latest，M0.5 再锁定）

```yaml
name: codecrush
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: codecrush
      POSTGRES_PASSWORD: codecrush
      POSTGRES_DB: codecrush
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./postgres/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U codecrush -d codecrush"]
      interval: 5s
      timeout: 3s
      retries: 12
    profiles: ["infra", "full"]

  clickhouse:
    image: clickhouse/clickhouse-server:latest
    ports:
      - "8123:8123"
      - "9000:9000"
    volumes:
      - chdata:/var/lib/clickhouse
      - ./clickhouse/init:/docker-entrypoint-initdb.d:ro
    ulimits:
      nofile:
        soft: 262144
        hard: 262144
    # M0 不加 healthcheck（镜像未必自带 wget）；M0.5 接线时再补。M0 只要求 postgres healthy。
    profiles: ["infra", "full"]

  otel-collector:
    image: otel/opentelemetry-collector-contrib:latest
    command: ["--config=/etc/otelcol-contrib/config.yaml"]
    volumes:
      - ./collector/config.yaml:/etc/otelcol-contrib/config.yaml:ro
    ports:
      - "4317:4317"
      - "4318:4318"
    depends_on:
      clickhouse:
        condition: service_started
    profiles: ["infra", "full"]

volumes:
  pgdata:
  chdata:
```

**验证 Story 3**:

```bash
docker compose -f infra/docker-compose.yml --profile infra up -d
sleep 8 && docker compose -f infra/docker-compose.yml ps
```
期望 `postgres` 状态含 `healthy`；clickhouse/collector 至少 running。

---

## Story 4 — `apps/backend`（NestJS 模块化单体骨架）

- [ ] **4.1** 先写 `apps/backend/package.json`（**scoped name 在前，再装依赖**，同 2.1 理由）

```json
{
  "name": "@codecrush/backend",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "nest build",
    "start": "nest start",
    "dev": "nest start --watch",
    "test": "jest",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx src/db/migrate.ts"
  }
}
```

- [ ] **4.2** 建 src 目录并装依赖（`pnpm add` 把版本写回 package.json；`@codecrush/contracts` 以 `workspace:*` 记入）

```bash
mkdir -p apps/backend/src
pnpm --filter @codecrush/backend add @nestjs/common @nestjs/core @nestjs/platform-express @nestjs/config \
  drizzle-orm pg nestjs-zod zod reflect-metadata rxjs @codecrush/contracts
pnpm --filter @codecrush/backend add -D @nestjs/cli @nestjs/testing @nestjs/schematics \
  typescript ts-jest jest @types/jest @types/node @types/pg @types/supertest supertest \
  drizzle-kit tsx dotenv
```

- [ ] **4.3** 写 `apps/backend/nest-cli.json`

```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": { "deleteOutDir": true }
}
```

- [ ] **4.4** 写 `apps/backend/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "CommonJS",
    "moduleResolution": "Node",
    "target": "ES2022",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "outDir": "./dist",
    "baseUrl": "./",
    "sourceMap": true
  },
  "include": ["src", "drizzle.config.ts"]
}
```

- [ ] **4.5** 写 `apps/backend/.env.example`（D4：M0 必填三项，CH/OTLP 注释留 M0.5）

```dotenv
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://codecrush:codecrush@localhost:5432/codecrush
# M0.5+：
# CLICKHOUSE_URL=http://localhost:8123
# OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
```

- [ ] **4.6** 生成本地 env

```bash
cp apps/backend/.env.example apps/backend/.env
```

- [ ] **4.7** 写 config（Zod env 校验 fail-fast）

`apps/backend/src/platform/config/config.schema.ts`
```ts
import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  // D4：M0.5 变量在 M0 可选
  CLICKHOUSE_URL: z.string().url().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
});
export type Env = z.infer<typeof envSchema>;
```

`apps/backend/src/platform/config/config.service.ts`
```ts
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "./config.schema";

@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}
  get nodeEnv(): Env["NODE_ENV"] {
    return this.config.get("NODE_ENV", { infer: true });
  }
  get port(): number {
    return this.config.get("PORT", { infer: true });
  }
  get databaseUrl(): string {
    return this.config.get("DATABASE_URL", { infer: true });
  }
}
```

`apps/backend/src/platform/config/config.module.ts`
```ts
import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { envSchema } from "./config.schema";
import { AppConfigService } from "./config.service";

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (raw) => envSchema.parse(raw), // 抛错即 fail-fast
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
```

- [ ] **4.8** 写 persistence（Drizzle client provider）

`apps/backend/src/platform/persistence/drizzle.constants.ts`
```ts
export const DRIZZLE = Symbol("DRIZZLE");
```

`apps/backend/src/platform/persistence/persistence.module.ts`
```ts
import { Global, Module } from "@nestjs/common";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { AppConfigService } from "../config/config.service";
import * as schema from "../../db/schema";
import { DRIZZLE } from "./drizzle.constants";

export type DB = NodePgDatabase<typeof schema>;

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): DB => {
        const pool = new Pool({ connectionString: config.databaseUrl });
        return drizzle(pool, { schema });
      },
    },
  ],
  exports: [DRIZZLE],
})
export class PersistenceModule {}
```

- [ ] **4.9** 写示例 schema（M0 最小表，不含 vector 列 — D5）

`apps/backend/src/db/schema.ts`
```ts
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const appMeta = pgTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
```

- [ ] **4.10** 写 drizzle 配置与迁移脚本

`apps/backend/drizzle.config.ts`
```ts
import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

`apps/backend/src/db/migrate.ts`
```ts
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./drizzle" });
  await pool.end();
  // eslint-disable-next-line no-console
  console.log("migrations applied");
}
main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
```

- [ ] 🧪 **4.11** 先写 health 测试 `apps/backend/test/health.controller.spec.ts`（红）

```ts
import { Test } from "@nestjs/testing";
import { HealthController } from "../src/modules/health/health.controller";
import { DRIZZLE } from "../src/platform/persistence/drizzle.constants";

async function build(execute: () => Promise<unknown>) {
  const ref = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [{ provide: DRIZZLE, useValue: { execute } }],
  }).compile();
  return ref.get(HealthController);
}

describe("HealthController", () => {
  it("returns ok when db reachable", async () => {
    const ctrl = await build(async () => ({}));
    const res = await ctrl.check();
    expect(res.status).toBe("ok");
    expect(res.db).toBe("up");
  });
  it("returns error when db down", async () => {
    const ctrl = await build(async () => {
      throw new Error("down");
    });
    const res = await ctrl.check();
    expect(res.status).toBe("error");
    expect(res.db).toBe("down");
  });
});
```

- [ ] **4.12** 写 health controller/module（绿；手写，D1）

`apps/backend/src/modules/health/health.controller.ts`
```ts
import { Controller, Get, Inject } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { HealthResponse } from "@codecrush/contracts";
import { DRIZZLE } from "../../platform/persistence/drizzle.constants";
import type { DB } from "../../platform/persistence/persistence.module";

@Controller("health")
export class HealthController {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  @Get()
  async check(): Promise<HealthResponse> {
    let db: "up" | "down" = "up";
    try {
      await this.db.execute(sql`SELECT 1`);
    } catch {
      db = "down";
    }
    return { status: db === "up" ? "ok" : "error", db, details: { db: { status: db } } };
  }
}
```

`apps/backend/src/modules/health/health.module.ts`
```ts
import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";

@Module({ controllers: [HealthController] })
export class HealthModule {}
```

- [ ] **4.13** 写 app.module 与 main

`apps/backend/src/app.module.ts`
```ts
import { Module } from "@nestjs/common";
import { AppConfigModule } from "./platform/config/config.module";
import { PersistenceModule } from "./platform/persistence/persistence.module";
import { HealthModule } from "./modules/health/health.module";

@Module({ imports: [AppConfigModule, PersistenceModule, HealthModule] })
export class AppModule {}
```

`apps/backend/src/main.ts`
```ts
// M0.5 将改为经 `node -r ./dist/tracing.js dist/main.js` 预加载 OTel（此处预留）
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { AppConfigService } from "./platform/config/config.service";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors(); // dev 放开；后续收紧
  const config = app.get(AppConfigService);
  await app.listen(config.port);
  // eslint-disable-next-line no-console
  console.log(`backend listening on :${config.port}`);
}
void bootstrap();
```

- [ ] **4.14** 写 jest 配置 `apps/backend/jest.config.js`（contracts 走 src 源码映射，测试无需先构建 contracts）

```js
/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["**/*.spec.ts"],
  moduleNameMapper: {
    "^@codecrush/contracts$": "<rootDir>/../../packages/contracts/src/index.ts",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json" }],
  },
};
```

- [ ] **4.15** 生成迁移并跑测试

```bash
pnpm --filter @codecrush/backend db:generate   # 生成 drizzle/0000_*.sql（含 app_meta）
pnpm --filter @codecrush/backend test          # 4.11 两个用例应绿
```

**验证 Story 4**（需 Story 3 的 postgres healthy）:

```bash
pnpm --filter @codecrush/backend db:migrate     # 期望打印 "migrations applied"
pnpm --filter @codecrush/backend build && pnpm --filter @codecrush/backend start &
sleep 4 && curl -s localhost:3000/health         # 期望 {"status":"ok","db":"up",...}
```

---

## Story 5 — `apps/frontend`（React + Vite + antd 骨架）

- [ ] **5.1** 先写 `apps/frontend/package.json`（**scoped name 在前，再装依赖**，同 2.1 理由）

```json
{
  "name": "@codecrush/frontend",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  }
}
```

- [ ] **5.2** 建目录并装依赖（`pnpm add` 把版本写回 package.json）

```bash
mkdir -p apps/frontend/src/app apps/frontend/src/pages apps/frontend/src/api apps/frontend/src/test
pnpm --filter @codecrush/frontend add react react-dom react-router-dom antd @ant-design/icons @codecrush/contracts
pnpm --filter @codecrush/frontend add -D vite @vitejs/plugin-react typescript @types/react @types/react-dom \
  vitest jsdom @testing-library/react @testing-library/jest-dom
```

- [ ] **5.3** 写 `apps/frontend/vite.config.ts`（D3：`/health` 代理到后端；vitest test 配置同文件）

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/health": "http://localhost:3000" },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.ts",
  },
});
```

- [ ] **5.4** 写 `apps/frontend/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "noEmit": true,
    "declaration": false,
    "types": ["vite/client", "vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src"]
}
```

- [ ] **5.5** 写 `apps/frontend/index.html`

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CodeCrushBot 控制台</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **5.6** 写 `apps/frontend/src/api/client.ts`（类型化，消费 contracts）

```ts
import { HealthResponseSchema, type HealthResponse } from "@codecrush/contracts";

export async function getHealth(): Promise<HealthResponse> {
  const res = await fetch("/health");
  return HealthResponseSchema.parse(await res.json());
}
```

- [ ] **5.7** 写页面占位

`apps/frontend/src/pages/HomePage.tsx`
```tsx
import { useEffect, useState } from "react";
import { Card, Tag } from "antd";
import { getHealth } from "../api/client";

export function HomePage() {
  const [status, setStatus] = useState("...");
  useEffect(() => {
    getHealth()
      .then((h) => setStatus(`${h.status} · db:${h.db}`))
      .catch(() => setStatus("unreachable"));
  }, []);
  return (
    <Card title="快速开始（M0 骨架）">
      <p>
        后端健康：<Tag color="blue">{status}</Tag>
      </p>
    </Card>
  );
}
```

`apps/frontend/src/pages/LoginPage.tsx`
```tsx
import { Card } from "antd";

export function LoginPage() {
  return <Card title="登录（占位，M1 实现）" />;
}
```

- [ ] **5.8** 写 app shell `apps/frontend/src/app/App.tsx`

```tsx
import { Layout, Menu } from "antd";
import { Routes, Route, Link, useLocation } from "react-router-dom";
import { HomePage } from "../pages/HomePage";
import { LoginPage } from "../pages/LoginPage";

const { Header, Sider, Content } = Layout;

export function App() {
  const loc = useLocation();
  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider theme="light">
        <div style={{ padding: 16, fontWeight: 600 }}>CodeCrushBot</div>
        <Menu
          mode="inline"
          selectedKeys={[loc.pathname]}
          items={[
            { key: "/", label: <Link to="/">控制台</Link> },
            { key: "/login", label: <Link to="/login">登录</Link> },
          ]}
        />
      </Sider>
      <Layout>
        <Header style={{ background: "#fff" }}>管理后台</Header>
        <Content style={{ margin: 16 }}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/login" element={<LoginPage />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}
```

- [ ] **5.9** 写入口 `apps/frontend/src/main.tsx`（antd 主题对齐 mock 主色 #1677ff）

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app/App";

const theme = { token: { colorPrimary: "#1677ff", borderRadius: 6 } };

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={theme}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ConfigProvider>
  </React.StrictMode>,
);
```

- [ ] **5.10** 写测试 setup `apps/frontend/src/test/setup.ts`

```ts
import "@testing-library/jest-dom";
```

- [ ] 🧪 **5.11** 写 smoke 测试 `apps/frontend/src/app/App.test.tsx`

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "./App";

beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({
    json: async () => ({ status: "ok", db: "up" }),
  }) as unknown as typeof fetch;
});

it("renders the shell brand", () => {
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
  expect(screen.getByText("CodeCrushBot")).toBeInTheDocument();
});
```

- [ ] **5.12** 跑测试

```bash
pnpm --filter @codecrush/frontend test   # smoke 用例绿
```

**验证 Story 5**（需 Story 4 后端在跑）:

```bash
pnpm --filter @codecrush/frontend dev
# 浏览器打开 http://localhost:5173 ，看到 antd 布局壳 + "后端健康：ok · db:up"
```

---

## Story 6 — 验收（对齐 spec §5 八条）

- [ ] **6.1** 全量安装 & 构建

```bash
pnpm install
pnpm build            # turbo：contracts→backend→frontend 依赖有序
```

- [ ] **6.2** infra 起 + 迁移 + health（验收 2/3/4）

```bash
docker compose -f infra/docker-compose.yml --profile infra up -d
sleep 8 && docker compose -f infra/docker-compose.yml ps          # postgres healthy
pnpm db:migrate                                                    # migrations applied
pnpm --filter @codecrush/backend start & sleep 4
curl -s localhost:3000/health                                      # {"status":"ok","db":"up",...}
```

- [ ] **6.3** 测试全绿（验收 6）

```bash
pnpm test    # contracts + backend health + frontend smoke
```

- [ ] **6.4** Lint 边界真的生效（验收 5）—— 故意越界应报错

```bash
pnpm lint    # 期望 0 error
# 临时在 apps/frontend/src/api/client.ts 顶部加一行：
#   import "@codecrush/backend";
pnpm lint    # 期望：报 no-restricted-imports 错误（证明边界生效）
# 验证后删除该行，pnpm lint 复绿
```

- [ ] **6.5** env fail-fast（验收 8）

```bash
# 临时注释 apps/backend/.env 里的 DATABASE_URL 再启动：
pnpm --filter @codecrush/backend start
# 期望：ZodError 打印缺失 DATABASE_URL 并退出（非静默）
# 验证后恢复 .env
```

- [ ] **6.6** 前端 shell（验收 7）: `pnpm --filter @codecrush/frontend dev` 打开 5173，见布局壳 + 健康演示。

- [ ] **6.7** 收尾: `docker compose -f infra/docker-compose.yml down`（保留卷）。提交（若走 /ship:dev 会按 story 提交）。

---

## 自检清单（Plan → Drill 门）

- [x] 每个新建文件都给了完整内容，无 TODO/占位符
- [x] 依赖有序：contracts 先于 apps；infra 先于 backend 迁移；backend 先于 frontend 演示
- [x] TDD：contracts(2.4)、backend health(4.11)、frontend smoke(5.11) 均先测后码
- [x] 已知坑均有规避：pgvector 镜像(3.4)、env 可选项(4.7)、CORS 代理(5.3)、contracts CJS 消费(2.2)、jest 映射 contracts 源码(4.14)、turbo 持久 dev(0.6)
- [x] 验收 8 条逐条可执行（Story 6），含"边界越界应报错"与"env fail-fast"两个负向验证
- [x] 未触碰既有文件（仓库为空，无覆盖风险）
