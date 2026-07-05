# Dev Ledger — m0-engineering-foundation

Story 0: "仓库与 workspace 根" — complete
  Commits: 51d2540
  Files: .nvmrc, .gitignore, package.json, pnpm-workspace.yaml, turbo.json, pnpm-lock.yaml (+ 基线 docs/原型/.ship)
  Produces: pnpm workspace(apps/*, packages/*); root scripts dev/build/test/lint/format/db:*; turbo tasks(build/test/dev)
  Concerns: 初始提交含既有 docs/原型作为基线（无害）；实装版本比 plan 新（eslint 10 / typescript 6 / turbo 2.10），兼容

Story 1: "根 tooling (tsconfig/eslint/prettier)" — complete
  Commits: ced0cbd
  Files: tsconfig.base.json, .prettierrc, eslint.config.mjs
  Produces: 共享 tsconfig base; eslint flat(typescript-eslint recommended + no-restricted-imports 两条边界 + files:.ts/.tsx); prettier
  Concerns: 此刻仓库无 .ts 源码，`eslint .` 报"全被忽略"退 2（配置本身解析正常）；有源码后即正常，Story 2/6 验证

Story 2: "packages/contracts" — complete
  Commits: d9283c2
  Files: packages/contracts/{package.json,tsconfig.json,src/{index,health,otel,health.test}.ts}
  Produces: @codecrush/contracts → HealthResponseSchema/HealthResponse; GEN_AI/RAG OTLP 常量。CJS 产物 dist/。
  Verified: build 0 / lint 0 / test 0（2/2）
  Concerns: 实装 zod 4 / TS 6 / vitest 4（比 plan 新）；tsconfig 加 ignoreDeprecations "6.0" 静默 node10 弃用（TS7 前需迁移 nodenext，已记 revisit）

Story 3: "infra docker-compose" — complete
  Commits: 8de5cf7
  Files: infra/docker-compose.yml, infra/postgres/init.sql, infra/collector/config.yaml, infra/clickhouse/init/.gitkeep
  Produces: infra profile（postgres+pgvector healthy / clickhouse / otel-collector）；vector 扩展；collector otlp->debug（M0.5 再接 CH）
  Verified: compose up --wait 全 Healthy；vector 扩展存在
  Concerns: 镜像用 :latest（M0.5 锁定）；CH 自带 HEALTHCHECK 故仍显示 healthy（无碍）

Story 4: "apps/backend" — complete
  Commits: 8837f6d
  Files: apps/backend/{package.json,nest-cli.json,tsconfig.json,drizzle.config.ts,jest.config.js,.env.example, src/main.ts,app.module.ts, src/platform/config/*, src/platform/persistence/*, src/db/{schema,migrate}.ts, src/modules/health/*, test/health.controller.spec.ts, drizzle/0000_*.sql}
  Produces: NestJS app（AppConfigService/AppConfigModule; DRIZZLE token + DB 类型 + PersistenceModule; HealthModule GET /health）；db:generate/db:migrate 脚本；app_meta 表
  Verified: jest 2/2 · nest build 0 · db:migrate 应用成功 · curl /health 200 {"status":"ok","db":"up"} · eslint 0
  Concerns: 未装 nestjs-zod/supertest（M0 无消费，留 M1）；jest 用 @swc/jest 而非 ts-jest（TS6 兼容）；tsconfig 补 rootDir（TS6 TS5011）

Story 5: "apps/frontend" — complete
  Commits: 1322172
  Files: apps/frontend/{package.json,vite.config.ts,tsconfig.json,index.html, src/main.tsx, src/app/{App.tsx,App.test.tsx}, src/pages/{HomePage,LoginPage}.tsx, src/api/client.ts, src/test/setup.ts}
  Produces: React app shell（antd Layout/Menu，路由 / 与 /login 占位）；getHealth() 类型化 client；Vite /health 代理；antd 主题 colorPrimary #1677ff
  Verified: vitest 1/1 · eslint 0 · tsc --noEmit + vite build 0（antd6/react19/1559 模块）
  Concerns: 实装 antd 6 / Vite 8 / react-router 7（均新大版本，编译运行 OK）；bundle 903kB 仅警告

Story 6: "验收 8 条 + 回归" — complete
  Commits: (packageManager 修复见下条)
  Verified（8/8 验收）:
    1 pnpm install ✓  2 compose postgres healthy ✓  3 db:migrate ✓  4 curl /health 200 {"status":"ok","db":"up"} ✓
    5 eslint 0 且边界越界实报错（frontend import backend → no-restricted-imports error）✓
    6 pnpm test（turbo）4/4：contracts 2 + backend 2 + frontend 1 ✓  7 前端 shell：vite build + smoke 通过 ✓
    8 env fail-fast：缺 DATABASE_URL → ZodError 退出 ✓
  Concerns: turbo 2.10 需根 packageManager 字段（已补 pnpm@9.13.2）
