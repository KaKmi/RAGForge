# M0.5 Observability Closed Loop Implementation Plan

> **For agentic workers:** Use `/ship:dev` to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Build the M0.5 observability closed loop: backend manual span -> OTel Collector -> ClickHouse exporter-owned `otel_traces` -> project defensive view -> traces API.

**Architecture:** Keep writes standard and portable: application emits OTLP only, Collector owns ClickHouse trace tables, backend reads only through a stable project view. Split pure telemetry vocabulary into `@codecrush/otel-conventions`, Node runtime telemetry into `@codecrush/otel`, and keep API DTOs in `@codecrush/contracts`.

**Tech Stack:** Node >=22, pnpm 9, TypeScript 6, NestJS 11, Jest backend tests, Vitest package tests, OpenTelemetry JS SDK, OTel Collector contrib ClickHouse exporter, ClickHouse HTTP client.

## Global Constraints

- Node >=22 and pnpm 9.
- TypeScript strict; Prettier uses semicolons, double quotes, printWidth 100, trailing commas.
- Docker with Compose is required for the M0.5 runtime smoke path.
- `@codecrush/contracts` must depend only on `zod`.
- `@codecrush/otel-conventions` must have zero runtime dependencies.
- `@codecrush/otel` is Node-only and must not be imported by frontend or contracts.
- `@codecrush/otel` must not depend on `@codecrush/contracts`, ClickHouse, backend modules, or Trace API DTOs.
- `@codecrush/contracts` must not export OTLP attribute constants; those live in `@codecrush/otel-conventions`.
- Applications must emit OTLP only and must not write exporter-owned ClickHouse trace tables directly.
- ClickHouse trace reads must go through the defensive view `codecrush_trace_spans`.
- `POST /traces/hello` emits a manual span named exactly `manual.hello`.
- Telemetry startup/export failure must not prevent backend startup or `/health`.
- Use pinned images: `otel/opentelemetry-collector-contrib:0.130.1` and `clickhouse/clickhouse-server:25.6`.
- Do not implement M9 UI, RAG spans, chat integration, sessions API, payload offload, replay, dashboards, or agent/tool runtime behavior in M0.5.
- Do not include commit steps in implementation tasks; this repository commits only when the user explicitly requests it.

---

## Review 修正注记（peer review 后补，dev 时落地）

这些是评审发现、需在对应 Task 实现时注意的修正点，已在下方代码块尽量就地修好：

- **[N1 / 已就地修] `TracesService.emitHello` 类型错配（Task 3）**：`@codecrush/otel` 的 `emitManualHelloSpan()` 返回中性 `SpanIdentity`（`name: string`），不能直接当 `HelloTraceResponse` 返回（其 `name` 是 `z.literal("manual.hello")`，strict 下 `string` 不可赋给字面量，TS2322）。service 里显式构造 DTO：`{ traceId, spanId, name: "manual.hello" }`。**不要为了绕过而把 schema 的 literal 放宽成 string。**
- **[N2 / dev 时验证] 锁 VIEW 列名前先实测 exporter schema（Task 4）**：`001-trace-views.sql` 假设 `clickhouseexporter` 建的列为 `TraceId/SpanId/ParentSpanId/SpanName/SpanKind/Timestamp/Duration(纳秒)/StatusCode/SpanAttributes`。这些列名随 collector 版本会漂。**在写死 VIEW 之前**，先用 pinned 的 `otel/opentelemetry-collector-contrib:0.130.1` 起 collector、打一条 span，再 `DESCRIBE otel_traces` 核对真实列名/类型；不符就改 VIEW SQL（防腐层），**不要改 controller/DTO**。
- **[N3 / 接真实 trace 前修，hello 阶段可放行] `startTime` 时区**：repository 用 `new Date(row.start_time).toISOString()`，而 ClickHouse `Timestamp` 经 JSONEachRow 返回的是 `"YYYY-MM-DD hh:mm:ss.fffffffff"`（无 `Z` 的非 ISO 串），`new Date` 会按**本地时区**解析产生偏移。首选在 VIEW 里直接输出 UTC ISO（如 `formatDateTime(Timestamp, '%FT%T', 'UTC')` 或等价、含毫秒+`Z`），否则 repository 端按 UTC 显式解析。M0.5 hello span 不阻塞，但 M8 接真实 trace 前必修。

---

### Task 1: Pure Conventions And Trace Contracts

**Files:**
- Create: `packages/otel-conventions/package.json`
- Create: `packages/otel-conventions/tsconfig.json`
- Create: `packages/otel-conventions/src/index.ts`
- Create: `packages/otel-conventions/src/index.test.ts`
- Create: `packages/contracts/src/traces.ts`
- Create: `packages/contracts/src/traces.test.ts`
- Modify: `packages/contracts/package.json`
- Modify: `packages/contracts/src/index.ts`
- Delete: `packages/contracts/src/otel.ts`

**Interfaces:**
- Produces: `GEN_AI`, `RAG`, `OTEL_OPERATIONS`, `CODECRUSH_SPAN_KIND` from `@codecrush/otel-conventions`; these constants are not exported by `@codecrush/contracts`.
- Produces: `HelloTraceResponseSchema`, `TraceSpanSchema`, `TraceDetailResponseSchema`, and inferred types from `@codecrush/contracts`.
- Consumed by later tasks: backend traces controller returns `HelloTraceResponse` and `TraceDetailResponse`; `@codecrush/otel` uses convention constants.

**Tier:** standard

- [ ] **Step 1: Write failing conventions tests**

Create `packages/otel-conventions/src/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CODECRUSH_SPAN_KIND, GEN_AI, OTEL_OPERATIONS, RAG } from "./index";

describe("otel conventions", () => {
  it("exposes stable GenAI and RAG attribute keys", () => {
    expect(GEN_AI.REQUEST_MODEL).toBe("gen_ai.request.model");
    expect(GEN_AI.OPERATION_NAME).toBe("gen_ai.operation.name");
    expect(RAG.RETRIEVAL_TOP_K).toBe("rag.retrieval.top_k");
  });

  it("exposes generic operation and span kind names", () => {
    expect(OTEL_OPERATIONS.CHAT).toBe("chat");
    expect(OTEL_OPERATIONS.RETRIEVE).toBe("retrieve");
    expect(CODECRUSH_SPAN_KIND.LLM).toBe("llm");
    expect(CODECRUSH_SPAN_KIND.CUSTOM).toBe("custom");
  });
});
```

Run: `pnpm --filter @codecrush/otel-conventions test`

Expected: FAIL because the package does not exist yet.

- [ ] **Step 2: Write failing contract tests**

Create `packages/contracts/src/traces.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HelloTraceResponseSchema, TraceDetailResponseSchema } from "./traces";

describe("trace contracts", () => {
  it("accepts a hello trace response", () => {
    expect(
      HelloTraceResponseSchema.parse({
        traceId: "391dae938234560b16bb63f51501cb6f",
        spanId: "6bb63f51501cb6f1",
        name: "manual.hello",
      }),
    ).toEqual({
      traceId: "391dae938234560b16bb63f51501cb6f",
      spanId: "6bb63f51501cb6f1",
      name: "manual.hello",
    });
  });

  it("accepts a normalized trace detail response", () => {
    const result = TraceDetailResponseSchema.safeParse({
      traceId: "391dae938234560b16bb63f51501cb6f",
      spans: [
        {
          traceId: "391dae938234560b16bb63f51501cb6f",
          spanId: "6bb63f51501cb6f1",
          parentSpanId: null,
          name: "manual.hello",
          kind: "custom",
          startTime: "2026-07-05T00:00:00.000Z",
          durationMs: 12.5,
          statusCode: "Ok",
          attributes: { "codecrush.test": "hello" },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects malformed trace identifiers", () => {
    expect(
      HelloTraceResponseSchema.safeParse({
        traceId: "short",
        spanId: "also-short",
        name: "manual.hello",
      }).success,
    ).toBe(false);
  });
});
```

Run: `pnpm --filter @codecrush/contracts test`

Expected: FAIL with module resolution errors for `./traces`.

- [ ] **Step 3: Implement `@codecrush/otel-conventions`**

Create `packages/otel-conventions/package.json`:

```json
{
  "name": "@codecrush/otel-conventions",
  "version": "0.0.0",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^6.0.3",
    "vitest": "^4.1.9"
  }
}
```

Create `packages/otel-conventions/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "CommonJS",
    "moduleResolution": "node10",
    "ignoreDeprecations": "6.0",
    "target": "ES2021",
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "exclude": ["**/*.test.ts"]
}
```

Create `packages/otel-conventions/src/index.ts`:

```ts
export const GEN_AI = {
  SYSTEM: "gen_ai.system",
  OPERATION_NAME: "gen_ai.operation.name",
  REQUEST_MODEL: "gen_ai.request.model",
  USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  TOOL_NAME: "gen_ai.tool.name",
  TOOL_CALL_ID: "gen_ai.tool.call.id",
  TOOL_TYPE: "gen_ai.tool.type",
  AGENT_NAME: "gen_ai.agent.name",
  AGENT_ID: "gen_ai.agent.id",
} as const;

export const RAG = {
  RETRIEVAL_TOP_K: "rag.retrieval.top_k",
  RETRIEVAL_TOP_N: "rag.retrieval.top_n",
  RETRIEVAL_THRESHOLD: "rag.retrieval.threshold",
  MULTI_RECALL: "rag.multi",
  CHUNK_SCORES: "rag.chunk.scores",
  CITATION_IDS: "rag.citation.ids",
  COST_USD: "rag.cost.usd",
  PROMPT_VERSION_ID: "rag.prompt.version_id",
} as const;

export const OTEL_OPERATIONS = {
  CHAT: "chat",
  TEXT_COMPLETION: "text_completion",
  EMBEDDINGS: "embeddings",
  EXECUTE_TOOL: "execute_tool",
  INVOKE_AGENT: "invoke_agent",
  CREATE_AGENT: "create_agent",
  RETRIEVE: "retrieve",
  RERANK: "rerank",
  KEYWORD_RECALL: "keyword_recall",
  HITS: "hits",
  CUSTOM: "custom",
} as const;

export const CODECRUSH_SPAN_KIND = {
  LLM: "llm",
  EMBEDDINGS: "embeddings",
  RETRIEVAL: "retrieval",
  RERANK: "rerank",
  TOOL: "tool",
  AGENT: "agent",
  EVENT: "event",
  CUSTOM: "custom",
} as const;
```

Verify `packages/contracts/package.json` keeps only `zod` in dependencies:

```json
"dependencies": {
  "zod": "^4.4.3"
}
```

Delete `packages/contracts/src/otel.ts`. If the implementer prefers a two-step migration, first remove it from `packages/contracts/src/index.ts`, run `rg -n "GEN_AI|RAG" packages apps`, and then delete the file once the search confirms no application imports remain.

- [ ] **Step 4: Implement trace DTO contracts**

Create `packages/contracts/src/traces.ts`:

```ts
import { z } from "zod";

const traceIdSchema = z.string().regex(/^[a-f0-9]{32}$/i);
const spanIdSchema = z.string().regex(/^[a-f0-9]{16}$/i);

export const HelloTraceResponseSchema = z.object({
  traceId: traceIdSchema,
  spanId: spanIdSchema,
  name: z.literal("manual.hello"),
});
export type HelloTraceResponse = z.infer<typeof HelloTraceResponseSchema>;

export const TraceSpanSchema = z.object({
  traceId: traceIdSchema,
  spanId: spanIdSchema,
  parentSpanId: spanIdSchema.nullable(),
  name: z.string().min(1),
  kind: z.string().min(1),
  startTime: z.string().datetime(),
  durationMs: z.number().nonnegative(),
  statusCode: z.string(),
  attributes: z.record(z.string(), z.unknown()),
});
export type TraceSpan = z.infer<typeof TraceSpanSchema>;

export const TraceDetailResponseSchema = z.object({
  traceId: traceIdSchema,
  spans: z.array(TraceSpanSchema),
});
export type TraceDetailResponse = z.infer<typeof TraceDetailResponseSchema>;
```

Modify `packages/contracts/src/index.ts`:

```ts
export * from "./health";
export * from "./traces";
```

- [ ] **Step 5: Verify package boundaries and packages**

Run: `rg -n "GEN_AI|RAG|OTEL_OPERATIONS|CODECRUSH_SPAN_KIND" packages/contracts/src`

Expected: no output. `@codecrush/contracts` should expose only API DTOs, not OTLP constants.

Run: `pnpm --filter @codecrush/otel-conventions test && pnpm --filter @codecrush/otel-conventions build && pnpm --filter @codecrush/contracts test && pnpm --filter @codecrush/contracts build`

Expected: PASS.


### Task 2: Node Telemetry SDK And Backend Preload

**Files:**
- Create: `packages/otel/package.json`
- Create: `packages/otel/tsconfig.json`
- Create: `packages/otel/src/index.ts`
- Create: `packages/otel/src/node-sdk.ts`
- Create: `packages/otel/src/trace.ts`
- Create: `packages/otel/src/trace.test.ts`
- Create: `apps/backend/src/tracing.ts`
- Create: `apps/backend/test/tracing.spec.ts`
- Modify: `apps/backend/package.json`
- Modify: `apps/backend/jest.config.js`

**Interfaces:**
- Consumes: `CODECRUSH_SPAN_KIND`, `OTEL_OPERATIONS` from Task 1.
- Produces: `StartNodeTelemetryOptions = { serviceName: string; serviceVersion?: string; otlpEndpoint?: string; enabled?: boolean; logger?: Pick<Console, "error" | "warn" | "info"> }`.
- Produces: `SpanIdentity = { traceId: string; spanId: string; name: string }`.
- Produces: `startNodeTelemetry(options: StartNodeTelemetryOptions): void`, `withSpan<T>(name: string, options: { attributes?: SpanAttributes } | undefined, fn: (span: Span) => Promise<T> | T): Promise<T>`, `emitManualHelloSpan(): Promise<SpanIdentity>`, `forceFlushTelemetry(timeoutMs?: number): Promise<void>`.
- Consumed by later tasks: `TracesService.emitHello()` calls `emitManualHelloSpan()`.

**Tier:** standard

- [ ] **Step 1: Write failing telemetry package test**

Create `packages/otel/src/trace.test.ts`:

```ts
import { context, trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { emitManualHelloSpan, resetTelemetryForTests } from "./trace";

describe("manual hello span", () => {
  afterEach(() => {
    resetTelemetryForTests();
  });

  it("returns the trace and span identifiers from a real span", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);

    const result = await emitManualHelloSpan();

    expect(result.name).toBe("manual.hello");
    expect(result.traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(result.spanId).toMatch(/^[a-f0-9]{16}$/);
    expect(exporter.getFinishedSpans().map((span) => span.name)).toContain("manual.hello");
    expect(trace.getSpan(context.active())).toBeUndefined();
  });
});
```

Run: `pnpm --filter @codecrush/otel test`

Expected: FAIL because package and files do not exist.

- [ ] **Step 2: Create `@codecrush/otel` package**

Create `packages/otel/package.json`:

```json
{
  "name": "@codecrush/otel",
  "version": "0.0.0",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@codecrush/otel-conventions": "workspace:^",
    "@opentelemetry/api": "^1.9.0",
    "@opentelemetry/exporter-trace-otlp-grpc": "^0.57.2",
    "@opentelemetry/instrumentation-http": "^0.57.2",
    "@opentelemetry/resources": "^1.30.1",
    "@opentelemetry/sdk-node": "^0.57.2",
    "@opentelemetry/sdk-trace-base": "^1.30.1",
    "@opentelemetry/semantic-conventions": "^1.30.0"
  },
  "devDependencies": {
    "typescript": "^6.0.3",
    "vitest": "^4.1.9"
  }
}
```

Create `packages/otel/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "CommonJS",
    "moduleResolution": "node10",
    "ignoreDeprecations": "6.0",
    "target": "ES2022",
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "exclude": ["**/*.test.ts"]
}
```

Create `packages/otel/src/index.ts`:

```ts
export * from "./node-sdk";
export * from "./trace";
```

- [ ] **Step 3: Implement span helpers**

Create `packages/otel/src/trace.ts`:

```ts
import { SpanStatusCode, trace as otelTrace, type Span } from "@opentelemetry/api";
import { CODECRUSH_SPAN_KIND, OTEL_OPERATIONS } from "@codecrush/otel-conventions";

export type SpanAttributes = Record<string, string | number | boolean | string[] | number[] | boolean[]>;
export type SpanIdentity = {
  traceId: string;
  spanId: string;
  name: string;
};

let forceFlushHook: (() => Promise<void>) | undefined;

export function setForceFlushHookForTelemetry(hook: (() => Promise<void>) | undefined): void {
  forceFlushHook = hook;
}

export function resetTelemetryForTests(): void {
  forceFlushHook = undefined;
}

export async function forceFlushTelemetry(timeoutMs = 2000): Promise<void> {
  if (!forceFlushHook) return;
  await Promise.race([
    forceFlushHook(),
    new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs);
    }),
  ]);
}

export async function withSpan<T>(
  name: string,
  options: { attributes?: SpanAttributes } | undefined,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const tracer = otelTrace.getTracer("codecrush");
  return await tracer.startActiveSpan(name, { attributes: options?.attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

export async function emitManualHelloSpan(): Promise<SpanIdentity> {
  const result = await withSpan(
    "manual.hello",
    {
      attributes: {
        "codecrush.span.kind": CODECRUSH_SPAN_KIND.CUSTOM,
        "codecrush.test": "hello",
        "gen_ai.operation.name": OTEL_OPERATIONS.CUSTOM,
      },
    },
    (span) => {
      const spanContext = span.spanContext();
      return {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
        name: "manual.hello" as const,
      };
    },
  );
  await forceFlushTelemetry();
  return result;
}
```

- [ ] **Step 4: Implement best-effort NodeSDK startup**

Create `packages/otel/src/node-sdk.ts`:

```ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { setForceFlushHookForTelemetry } from "./trace";

let sdk: NodeSDK | undefined;
let spanProcessor: BatchSpanProcessor | undefined;

export type StartNodeTelemetryOptions = {
  serviceName: string;
  serviceVersion?: string;
  otlpEndpoint?: string;
  enabled?: boolean;
  logger?: Pick<Console, "error" | "warn" | "info">;
};

export function startNodeTelemetry(options: StartNodeTelemetryOptions): void {
  const logger = options.logger ?? console;
  if (options.enabled === false || !options.otlpEndpoint) {
    logger.warn("[otel] tracing disabled: OTEL_EXPORTER_OTLP_ENDPOINT is not set");
    return;
  }
  if (sdk) return;

  try {
    const traceExporter = new OTLPTraceExporter({ url: options.otlpEndpoint });
    spanProcessor = new BatchSpanProcessor(traceExporter, { scheduledDelayMillis: 500 });
    sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: options.serviceName,
        [ATTR_SERVICE_VERSION]: options.serviceVersion ?? "0.0.0",
      }),
      spanProcessors: [spanProcessor],
      instrumentations: [new HttpInstrumentation()],
    });
    sdk.start();
    setForceFlushHookForTelemetry(async () => {
      await spanProcessor?.forceFlush();
    });
    logger.info("[otel] tracing started");
  } catch (err) {
    logger.error("[otel] failed to start tracing", err);
    sdk = undefined;
  }
}

export async function shutdownTelemetry(): Promise<void> {
  await sdk?.shutdown();
  sdk = undefined;
  spanProcessor = undefined;
  setForceFlushHookForTelemetry(undefined);
}
```

Create `apps/backend/src/tracing.ts`:

```ts
import "dotenv/config";
import { startNodeTelemetry } from "@codecrush/otel";

startNodeTelemetry({
  serviceName: "codecrush-backend",
  serviceVersion: "0.0.0",
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
});
```

- [ ] **Step 5: Wire backend scripts and Jest mappings**

Modify `apps/backend/package.json`:

```json
"scripts": {
  "build": "nest build",
  "start": "node -r ./dist/tracing.js dist/main.js",
  "start:nest": "nest start",
  "dev": "nest start --watch",
  "test": "jest",
  "db:generate": "drizzle-kit generate",
  "db:migrate": "tsx src/db/migrate.ts"
},
"dependencies": {
  "@clickhouse/client": "^1.12.1",
  "@codecrush/contracts": "workspace:^",
  "@codecrush/otel": "workspace:^",
  "@codecrush/otel-conventions": "workspace:^"
}
```

Keep all existing backend dependencies when editing; only add these new entries and change scripts as shown.

Also add backend dev dependencies used by `apps/backend/test/tracing.spec.ts`:

```json
"devDependencies": {
  "@opentelemetry/api": "^1.9.0",
  "@opentelemetry/sdk-trace-base": "^1.30.1"
}
```

Keep all existing backend dev dependencies when editing; only add these two entries if they are not already present.

Modify `apps/backend/jest.config.js` `moduleNameMapper`:

```js
moduleNameMapper: {
  "^@codecrush/contracts$": "<rootDir>/../../packages/contracts/src/index.ts",
  "^@codecrush/otel$": "<rootDir>/../../packages/otel/src/index.ts",
  "^@codecrush/otel-conventions$": "<rootDir>/../../packages/otel-conventions/src/index.ts",
},
```

- [ ] **Step 6: Verify SDK package boundaries and write backend preload smoke test**

Run: `node -e "const pkg=require('./packages/otel/package.json'); if (pkg.dependencies?.['@codecrush/contracts']) process.exit(1)"`

Expected: PASS with exit code 0. `@codecrush/otel` must not depend on API contracts.

Create `apps/backend/test/tracing.spec.ts`:

```ts
import { emitManualHelloSpan } from "@codecrush/otel";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

describe("backend telemetry package wiring", () => {
  it("can create a manual hello span identity without Docker", async () => {
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
    });
    trace.setGlobalTracerProvider(provider);
    const result = await emitManualHelloSpan();
    expect(result.name).toBe("manual.hello");
    expect(result.traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(result.spanId).toMatch(/^[a-f0-9]{16}$/);
  });
});
```

Run: `pnpm --filter @codecrush/otel test && pnpm --filter @codecrush/otel build && pnpm --filter @codecrush/backend test && pnpm --filter @codecrush/backend build`

Expected: PASS.


### Task 3: Backend ClickHouse Platform And Traces API

**Files:**
- Create: `apps/backend/src/platform/clickhouse/clickhouse.constants.ts`
- Create: `apps/backend/src/platform/clickhouse/clickhouse.module.ts`
- Create: `apps/backend/src/platform/clickhouse/clickhouse.types.ts`
- Create: `apps/backend/src/modules/traces/traces.module.ts`
- Create: `apps/backend/src/modules/traces/traces.controller.ts`
- Create: `apps/backend/src/modules/traces/traces.service.ts`
- Create: `apps/backend/src/modules/traces/clickhouse-traces.repository.ts`
- Create: `apps/backend/test/traces.controller.spec.ts`
- Modify: `apps/backend/src/platform/config/config.schema.ts`
- Modify: `apps/backend/src/platform/config/config.service.ts`
- Modify: `apps/backend/.env.example`
- Modify: `apps/backend/src/app.module.ts`

**Interfaces:**
- Consumes: `emitManualHelloSpan()` from Task 2.
- Consumes: `HelloTraceResponse`, `TraceDetailResponse`, `TraceSpan` from Task 1.
- Produces: `CLICKHOUSE` provider token, `CodeCrushClickHouseClient`, `ClickHouseTracesRepository.findByTraceId(traceId: string): Promise<TraceDetailResponse>`, `ClickHouseTracesRepository.ensureTraceViews(): Promise<void>`, `TracesService.emitHello(): Promise<HelloTraceResponse>`.
- Assumes Task 4 creates canonical VIEW SQL at `infra/clickhouse/views/001-trace-views.sql`; repository code reads that file instead of duplicating SQL.

**Tier:** standard

- [ ] **Step 1: Write failing traces controller tests**

Create `apps/backend/test/traces.controller.spec.ts`:

```ts
import { Test } from "@nestjs/testing";
import type { HelloTraceResponse, TraceDetailResponse } from "@codecrush/contracts";
import { TracesController } from "../src/modules/traces/traces.controller";
import { TracesService } from "../src/modules/traces/traces.service";

describe("TracesController", () => {
  async function build(service: Partial<TracesService>) {
    const ref = await Test.createTestingModule({
      controllers: [TracesController],
      providers: [{ provide: TracesService, useValue: service }],
    }).compile();
    return ref.get(TracesController);
  }

  it("emits a manual hello span", async () => {
    const response: HelloTraceResponse = {
      traceId: "391dae938234560b16bb63f51501cb6f",
      spanId: "6bb63f51501cb6f1",
      name: "manual.hello",
    };
    const ctrl = await build({ emitHello: async () => response } as Partial<TracesService>);
    await expect(ctrl.emitHello()).resolves.toEqual(response);
  });

  it("reads normalized trace detail by trace id", async () => {
    const detail: TraceDetailResponse = {
      traceId: "391dae938234560b16bb63f51501cb6f",
      spans: [
        {
          traceId: "391dae938234560b16bb63f51501cb6f",
          spanId: "6bb63f51501cb6f1",
          parentSpanId: null,
          name: "manual.hello",
          kind: "custom",
          startTime: "2026-07-05T00:00:00.000Z",
          durationMs: 1,
          statusCode: "Ok",
          attributes: { "codecrush.test": "hello" },
        },
      ],
    };
    const ctrl = await build({ getTrace: async () => detail } as Partial<TracesService>);
    await expect(ctrl.getTrace("391dae938234560b16bb63f51501cb6f")).resolves.toEqual(detail);
  });
});
```

Run: `pnpm --filter @codecrush/backend test -- traces.controller.spec.ts`

Expected: FAIL because traces module files do not exist.

- [ ] **Step 2: Extend config**

Modify `apps/backend/src/platform/config/config.schema.ts`:

```ts
import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  CLICKHOUSE_URL: z.string().default("http://localhost:8123"),
  CLICKHOUSE_DATABASE: z.string().default("default"),
  CLICKHOUSE_USERNAME: z.string().default("default"),
  CLICKHOUSE_PASSWORD: z.string().default(""),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
});
export type Env = z.infer<typeof envSchema>;
```

Modify `apps/backend/src/platform/config/config.service.ts`:

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
  get clickHouseUrl(): string {
    return this.config.get("CLICKHOUSE_URL", { infer: true });
  }
  get clickHouseDatabase(): string {
    return this.config.get("CLICKHOUSE_DATABASE", { infer: true });
  }
  get clickHouseUsername(): string {
    return this.config.get("CLICKHOUSE_USERNAME", { infer: true });
  }
  get clickHousePassword(): string {
    return this.config.get("CLICKHOUSE_PASSWORD", { infer: true });
  }
  get otelExporterOtlpEndpoint(): string | undefined {
    return this.config.get("OTEL_EXPORTER_OTLP_ENDPOINT", { infer: true });
  }
}
```

Modify `apps/backend/.env.example`:

```dotenv
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://codecrush:codecrush@localhost:5432/codecrush
CLICKHOUSE_URL=http://localhost:8123
CLICKHOUSE_DATABASE=default
CLICKHOUSE_USERNAME=default
CLICKHOUSE_PASSWORD=
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
```

- [ ] **Step 3: Add ClickHouse platform provider**

Create `apps/backend/src/platform/clickhouse/clickhouse.constants.ts`:

```ts
export const CLICKHOUSE = Symbol("CLICKHOUSE");
```

Create `apps/backend/src/platform/clickhouse/clickhouse.types.ts`:

```ts
import type { ClickHouseClient } from "@clickhouse/client";

export type CodeCrushClickHouseClient = ClickHouseClient;
```

Create `apps/backend/src/platform/clickhouse/clickhouse.module.ts`:

```ts
import { Global, Module } from "@nestjs/common";
import { createClient } from "@clickhouse/client";
import { AppConfigService } from "../config/config.service";
import { CLICKHOUSE } from "./clickhouse.constants";

@Global()
@Module({
  providers: [
    {
      provide: CLICKHOUSE,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        createClient({
          url: config.clickHouseUrl,
          database: config.clickHouseDatabase,
          username: config.clickHouseUsername,
          password: config.clickHousePassword,
        }),
    },
  ],
  exports: [CLICKHOUSE],
})
export class ClickHouseModule {}
```

- [ ] **Step 4: Implement traces repository/service/controller**

Create `apps/backend/src/modules/traces/clickhouse-traces.repository.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import type { TraceDetailResponse, TraceSpan } from "@codecrush/contracts";
import { CLICKHOUSE } from "../../platform/clickhouse/clickhouse.constants";
import type { CodeCrushClickHouseClient } from "../../platform/clickhouse/clickhouse.types";

export const TRACE_VIEW_NAME = "codecrush_trace_spans";
const TRACE_VIEW_SQL_PATH = join(
  process.cwd(),
  "infra",
  "clickhouse",
  "views",
  "001-trace-views.sql",
);

type ClickHouseTraceRow = {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: string;
  start_time: string;
  duration_ms: number;
  status_code: string;
  attributes: Record<string, unknown>;
};

@Injectable()
export class ClickHouseTracesRepository {
  constructor(@Inject(CLICKHOUSE) private readonly clickhouse: CodeCrushClickHouseClient) {}

  async ensureTraceViews(): Promise<void> {
    await this.waitForExporterTable();
    const viewSql = await readFile(TRACE_VIEW_SQL_PATH, "utf8");
    await this.clickhouse.command({ query: viewSql });
  }

  private async waitForExporterTable(): Promise<void> {
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const result = await this.clickhouse.query({
        query: "EXISTS TABLE otel_traces",
        format: "JSONEachRow",
      });
      const rows = await result.json<Array<{ result: 0 | 1 }>>();
      if (rows[0]?.result === 1) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("ClickHouse exporter table otel_traces was not created in time");
  }

  async findByTraceId(traceId: string): Promise<TraceDetailResponse> {
    await this.ensureTraceViews();
    const result = await this.clickhouse.query({
      query: `
        SELECT *
        FROM ${TRACE_VIEW_NAME}
        WHERE trace_id = {traceId:String}
        ORDER BY start_time ASC
      `,
      query_params: { traceId },
      format: "JSONEachRow",
    });
    const rows = await result.json<ClickHouseTraceRow[]>();
    return {
      traceId,
      spans: rows.map((row): TraceSpan => ({
        traceId: row.trace_id,
        spanId: row.span_id,
        parentSpanId: row.parent_span_id || null,
        name: row.name,
        kind: row.kind,
        startTime: new Date(row.start_time).toISOString(),
        durationMs: Number(row.duration_ms),
        statusCode: row.status_code,
        attributes: row.attributes ?? {},
      })),
    };
  }
}
```

Create `apps/backend/src/modules/traces/traces.service.ts`:

```ts
import { Injectable } from "@nestjs/common";
import { emitManualHelloSpan } from "@codecrush/otel";
import type { HelloTraceResponse, TraceDetailResponse } from "@codecrush/contracts";
import { ClickHouseTracesRepository } from "./clickhouse-traces.repository";

@Injectable()
export class TracesService {
  constructor(private readonly tracesRepository: ClickHouseTracesRepository) {}

  async emitHello(): Promise<HelloTraceResponse> {
    // SpanIdentity.name 是 string，HelloTraceResponse.name 是字面量 "manual.hello"；显式构造以满足契约类型
    const { traceId, spanId } = await emitManualHelloSpan();
    return { traceId, spanId, name: "manual.hello" };
  }

  async getTrace(traceId: string): Promise<TraceDetailResponse> {
    return await this.tracesRepository.findByTraceId(traceId);
  }
}
```

Create `apps/backend/src/modules/traces/traces.controller.ts`:

```ts
import { Controller, Get, Param, Post } from "@nestjs/common";
import type { HelloTraceResponse, TraceDetailResponse } from "@codecrush/contracts";
import { TracesService } from "./traces.service";

@Controller("traces")
export class TracesController {
  constructor(private readonly tracesService: TracesService) {}

  @Post("hello")
  async emitHello(): Promise<HelloTraceResponse> {
    return await this.tracesService.emitHello();
  }

  @Get(":traceId")
  async getTrace(@Param("traceId") traceId: string): Promise<TraceDetailResponse> {
    return await this.tracesService.getTrace(traceId);
  }
}
```

Create `apps/backend/src/modules/traces/traces.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { ClickHouseModule } from "../../platform/clickhouse/clickhouse.module";
import { ClickHouseTracesRepository } from "./clickhouse-traces.repository";
import { TracesController } from "./traces.controller";
import { TracesService } from "./traces.service";

@Module({
  imports: [ClickHouseModule],
  controllers: [TracesController],
  providers: [ClickHouseTracesRepository, TracesService],
})
export class TracesModule {}
```

Modify `apps/backend/src/app.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { AppConfigModule } from "./platform/config/config.module";
import { PersistenceModule } from "./platform/persistence/persistence.module";
import { HealthModule } from "./modules/health/health.module";
import { TracesModule } from "./modules/traces/traces.module";

@Module({ imports: [AppConfigModule, PersistenceModule, HealthModule, TracesModule] })
export class AppModule {}
```

- [ ] **Step 5: Verify backend tests/build**

Run: `pnpm --filter @codecrush/backend test -- traces.controller.spec.ts && pnpm --filter @codecrush/backend test && pnpm --filter @codecrush/backend build`

Expected: PASS.


### Task 4: Collector ClickHouse Export And Defensive View Source

**Files:**
- Modify: `infra/docker-compose.yml`
- Modify: `infra/collector/config.yaml`
- Create: `infra/clickhouse/views/001-trace-views.sql`
- Create: `apps/backend/scripts/verify-observability.mjs`
- Modify: `apps/backend/package.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: `POST /traces/hello` and `GET /traces/:traceId` from Task 3.
- Produces: Collector pipeline writing to `otel_traces`.
- Produces: source-controlled defensive view SQL for `codecrush_trace_spans`.
- Produces: `pnpm observability:verify` command.

**Tier:** standard

- [ ] **Step 1: Verify current infra is not yet wired**

Run:

```bash
[ ! -f infra/clickhouse/views/001-trace-views.sql ] && echo VIEW_MISSING
rg -n "debug:|otel/opentelemetry-collector-contrib:latest|clickhouse/clickhouse-server:latest" infra/collector/config.yaml infra/docker-compose.yml
```

Expected: prints `VIEW_MISSING`, plus current `debug:` exporter and `latest` image lines. This confirms Task 4 has real infra work to do before implementation.

- [ ] **Step 2: Write defensive view SQL outside Docker init**

Create `infra/clickhouse/views/001-trace-views.sql`:

```sql
CREATE VIEW IF NOT EXISTS codecrush_trace_spans AS
SELECT
  TraceId AS trace_id,
  SpanId AS span_id,
  nullIf(ParentSpanId, '') AS parent_span_id,
  SpanName AS name,
  if(SpanAttributes['codecrush.span.kind'] = '', toString(SpanKind), SpanAttributes['codecrush.span.kind']) AS kind,
  Timestamp AS start_time,
  toFloat64(Duration) / 1000000 AS duration_ms,
  toString(StatusCode) AS status_code,
  SpanAttributes AS attributes
FROM otel_traces;
```

Run: `test -s infra/clickhouse/views/001-trace-views.sql && rg -n "codecrush_trace_spans|otel_traces" infra/clickhouse/views/001-trace-views.sql`

Expected: PASS and prints both names.

- [ ] **Step 3: Update collector config**

Replace `infra/collector/config.yaml` with:

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

exporters:
  clickhouse:
    endpoint: tcp://clickhouse:9000?dial_timeout=10s
    database: default
    async_insert: true
    ttl: 720h
    compress: lz4
    create_schema: true
    traces_table_name: otel_traces
    timeout: 5s
    sending_queue:
      enabled: true
      num_consumers: 2
      queue_size: 1000
      batch:
        min_size: 1
        flush_timeout: 1s
  debug:
    verbosity: normal

processors:
  batch:
    timeout: 1s
    send_batch_size: 256

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [clickhouse, debug]
```

Run: `docker run --rm -v "$PWD/infra/collector/config.yaml:/etc/otelcol-contrib/config.yaml:ro" otel/opentelemetry-collector-contrib:0.130.1 validate --config=/etc/otelcol-contrib/config.yaml`

Expected: PASS with no config validation errors.

- [ ] **Step 4: Pin images and add health checks**

Modify `infra/docker-compose.yml` relevant services:

```yaml
  clickhouse:
    image: clickhouse/clickhouse-server:25.6
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
    healthcheck:
      test: ["CMD-SHELL", "clickhouse-client --query 'SELECT 1'"]
      interval: 5s
      timeout: 3s
      retries: 20
    profiles: ["infra", "full"]

  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.130.1
    command: ["--config=/etc/otelcol-contrib/config.yaml"]
    volumes:
      - ./collector/config.yaml:/etc/otelcol-contrib/config.yaml:ro
    ports:
      - "4317:4317"
      - "4318:4318"
    depends_on:
      clickhouse:
        condition: service_healthy
    profiles: ["infra", "full"]
```

Run: `docker compose -f infra/docker-compose.yml config >/tmp/codecrush-compose.yml`

Expected: PASS.

- [ ] **Step 5: Add end-to-end verification script**

Create `apps/backend/scripts/verify-observability.mjs`:

```js
const baseUrl = process.env.BACKEND_URL ?? "http://localhost:3000";

async function requestJson(path, init) {
  const res = await fetch(`${baseUrl}${path}`, init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${res.status} ${body}`);
  }
  return await res.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const hello = await requestJson("/traces/hello", { method: "POST" });
if (!/^[a-f0-9]{32}$/i.test(hello.traceId) || !/^[a-f0-9]{16}$/i.test(hello.spanId)) {
  throw new Error(`invalid hello response: ${JSON.stringify(hello)}`);
}

let detail;
let lastError;
for (let attempt = 1; attempt <= 20; attempt += 1) {
  try {
    detail = await requestJson(`/traces/${hello.traceId}`);
    if (detail.spans?.some((span) => span.name === "manual.hello")) {
      console.log(JSON.stringify({ status: "ok", traceId: hello.traceId, attempts: attempt }, null, 2));
      process.exit(0);
    }
  } catch (err) {
    lastError = err;
  }
  await sleep(500);
}

throw new Error(
  `trace ${hello.traceId} did not appear in ClickHouse view: ${JSON.stringify(detail)} ${lastError ?? ""}`,
);
```

Modify `apps/backend/package.json` scripts:

```json
"observability:verify": "node scripts/verify-observability.mjs"
```

Modify root `package.json` scripts:

```json
"observability:verify": "pnpm --filter @codecrush/backend observability:verify"
```

- [ ] **Step 6: Verify infra config**

Run:

```bash
docker compose -f infra/docker-compose.yml --profile infra up -d --wait
docker compose -f infra/docker-compose.yml ps --format json | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const rows=s.trim().split('\n').filter(Boolean).map(JSON.parse); const by=Object.fromEntries(rows.map(r=>[r.Service,r])); if(by.postgres.Health!=='healthy'||by.clickhouse.Health!=='healthy'||by['otel-collector'].State!=='running') process.exit(1); console.log('infra healthy')})"
```

Expected: prints `infra healthy`.


### Task 5: End-To-End Runtime Verification And README

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: documented M0.5 smoke commands and verified runtime evidence.

**Tier:** standard

- [ ] **Step 1: Verify README still describes M0.5 as pending**

Run:

```bash
rg -n "M0\\.5|可观测" README.md
```

Expected: prints the current README status lines for M0.5. Design docs already carry the architecture decision and should not be marked current/completed until implementation evidence exists.

- [ ] **Step 2: Add README smoke commands**

Modify `README.md` to add this section without changing design-doc status:

````md
## M0.5 可观测验证

```bash
docker compose -f infra/docker-compose.yml --profile infra up -d --wait
cp apps/backend/.env.example apps/backend/.env
pnpm build
pnpm --filter @codecrush/backend start
pnpm observability:verify
```

期望输出包含 `{"status":"ok","traceId":"391dae938234560b16bb63f51501cb6f"}` 形状的 JSON。该验证必须经过 Collector、ClickHouse `otel_traces` 和 `codecrush_trace_spans` 防腐 VIEW；不能由内存或 Postgres 伪造。
````

- [ ] **Step 3: Run unit/build checks**

Run:

```bash
pnpm lint
pnpm test
pnpm build
```

Expected: all PASS. The existing frontend Vitest may still print React act-wrapping warnings, but command exit status must be 0.

- [ ] **Step 4: Run real closed-loop smoke**

Run:

```bash
docker compose -f infra/docker-compose.yml --profile infra up -d --wait
cp -n apps/backend/.env.example apps/backend/.env
pnpm build
pnpm --filter @codecrush/backend start > /tmp/codecrush-backend.log 2>&1 &
BACKEND_PID=$!
for i in $(seq 1 30); do curl -fsS http://localhost:3000/health && break || sleep 1; done
grep -q "backend listening on :3000" /tmp/codecrush-backend.log
pnpm observability:verify
kill "$BACKEND_PID"
```

Expected: `/health` returns JSON with `"status":"ok"`, backend log contains `backend listening on :3000`, and `pnpm observability:verify` prints JSON containing `"status": "ok"` and a 32-hex-character `traceId`.

- [ ] **Step 5: Verify ClickHouse is the source and auto HTTP instrumentation works**

Run:

```bash
TRACE_ID="$(pnpm observability:verify | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).traceId))")"
curl 'http://localhost:8123/?query=SELECT%20name%20FROM%20codecrush_trace_spans%20WHERE%20trace_id%20%3D%20%7BtraceId%3AString%7D%20FORMAT%20JSONEachRow' \
  --data-urlencode "param_traceId=$TRACE_ID"
curl -fsS http://localhost:3000/health >/dev/null
sleep 2
curl 'http://localhost:8123/?query=SELECT%20count%28%29%20AS%20count%20FROM%20codecrush_trace_spans%20WHERE%20positionCaseInsensitive%28name%2C%20%27GET%27%29%20%3E%200%20AND%20positionCaseInsensitive%28name%2C%20%27health%27%29%20%3E%200%20FORMAT%20JSONEachRow'
```

Expected: first output contains `manual.hello`; second output contains a JSON row with `count` greater than 0, proving preloaded HTTP auto-instrumentation produced a `/health` span.


## Self-Review

- Spec coverage: all acceptance criteria are covered by Tasks 1-5.
- Placeholder scan: no unresolved placeholder phrases remain.
- Type consistency: trace DTO names are `HelloTraceResponse`, `TraceSpan`, and `TraceDetailResponse`; backend service and controller consume those exact names.
- Constraints propagation: global constraints list Node/pnpm, dependency purity, OTel write rule, view name, span name, and pinned image tags.
- Anti-shortcut check: verification requires `manual.hello` to be read from `codecrush_trace_spans`, not in-memory or Postgres state.
