# Dev Context — M0.5 可观测最小闭环

## Test Command
- 全量回归：`pnpm test`（turbo run test），`pnpm lint`（必须 0），`pnpm build`
- 单包：`pnpm --filter @codecrush/{otel-conventions|otel|contracts|backend} test|build`
- Collector 配置校验：`docker run --rm -v "$PWD/infra/collector/config.yaml:/etc/otelcol-contrib/config.yaml:ro" otel/opentelemetry-collector-contrib:0.130.1 validate --config=/etc/otelcol-contrib/config.yaml`

## Code Conduct
- TS strict；Prettier：semi、双引号、printWidth 100、trailingComma all。
- 后端测试 `@swc/jest`（decorators）；packages/前端用 vitest。
- 工作区依赖 `workspace:^`。包 tsconfig：`module CommonJS` + `moduleResolution node10` + `ignoreDeprecations "6.0"` + 显式 rootDir/outDir，继承 `tsconfig.base.json`。
- 依赖边界 ESLint 焊死（eslint.config.mjs Boundary ①–④）；lint 必须 0。
- 提交用 Conventional Commits，仅本 dev 流程内小步提交（用户已授权本次实现）。

## Pattern References
### Task 1: conventions + trace contracts
- Reference: `packages/contracts/src/health.ts` + `health.test.ts`
  - Mirror: Zod schema + `z.infer` 导出 type；vitest `describe/it/expect`，无 vitest.config（`vitest run` 默认）。
  - Deviations: traces 增加 regex 校验 traceId(32hex)/spanId(16hex)。
- otel-conventions 无现成参照（新地基包），镜像 contracts 的 package.json/tsconfig 形状（去掉 zod 依赖，零运行时依赖）。

### Task 2: @codecrush/otel + backend preload
- Reference: `packages/contracts`（包壳），`apps/backend/src/db/migrate.ts`（Node 入口 tsx 用法）。
  - Mirror: 包 exports/scripts；`tracing.ts` 作为 `-r` 预加载入口。
  - Deviations: otel 依赖 `@opentelemetry/*`；不得 import contracts/ClickHouse（Boundary ④）。

### Task 3: ClickHouse platform + traces API
- Reference: `apps/backend/src/platform/persistence/persistence.module.ts`（Global provider + Symbol token + useFactory 注入 config）；`modules/health/health.controller.ts`（Controller 注入 provider + 返回 contracts 类型）。
  - Mirror: `CLICKHOUSE = Symbol(...)`；`@Global()` ClickHouseModule；traces controller/service/module 照 health 三件套。
  - Deviations: N1 —— `emitHello` 显式构造 `{traceId,spanId,name:"manual.hello"}`（SpanIdentity.name:string 不可赋 literal）。

### Task 4: collector export + defensive view
- Reference: 现 `infra/collector/config.yaml`（保留 batch processor）、`infra/docker-compose.yml`（healthcheck 照 postgres 写法）。
  - N2 —— 锁 VIEW 列名前先起 collector 打 span、`DESCRIBE otel_traces` 核实真实列名。

### Task 5: README + runtime smoke
- Reference: `README.md` 现 M0.5 段落。仅加验证命令，不改设计文档状态。

## Waves
Task 间严格线性依赖（Interfaces consumes/produces）：
- Wave 1 = Task 1（otel-conventions + contracts/traces，删 contracts/otel.ts）
- Wave 2 = Task 2（@codecrush/otel + tracing.ts + backend scripts/jest 映射）← 消费 Wave 1 常量
- Wave 3 = Task 3（ClickHouse platform + traces module + config 扩展）← 消费 Wave 1 DTO + Wave 2 emitManualHelloSpan
- Wave 4 = Task 4（collector/compose/view SQL/verify 脚本）← 消费 Wave 3 端点
- Wave 5 = Task 5（README + 真实闭环冒烟）← 消费全部
全部单 story 顺序波；host 实现，peer 复核。
