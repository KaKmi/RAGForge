# M5 检索(Retrieval)Implementation Plan

> **For agentic workers:** Use /ship:dev to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 把 `retrieval` 模块从 M2 硬编码桩换成真实实现——向量召回(pgvector)+ 关键词召回(tsvector)+ 加权融合 + 可选 rerank,检索测试台前端接真实 API 并改用 antd 组件。

**Architecture:** 新增 `ModelProviderPort.rerank()`(镜像 `embed()` 模式)、`ChunksRepository.searchByVector/searchByKeyword`(经 `ChunksService` 薄封装暴露)、`retrieval` 模块新增 `RetrieverPort` + `PgHybridRetriever` 适配器承载编排逻辑(融合/降级/阈值/候选池上限),`RetrievalService` 变成薄封装调用该端口。设计依据 [`docs/design/008-m5-retrieval.md`](../../../docs/design/008-m5-retrieval.md),细节核实见 [`spec.md`](spec.md)。

**Tech Stack:** NestJS + Drizzle(Postgres/pgvector)+ Zod(nestjs-zod)+ Jest(`@swc/jest`)+ React 19 + antd 6。

**测试策略确认(用户已拍板,2026-07-09):** `ChunksRepository.searchByVector`/`searchByKeyword` 不新增连真实 Postgres 的集成测试,沿用本项目"仓储方法不单测"的既有先例;真实正确性靠 Task 11 完成后跑 `/ship:qa` 对着真实 docker-compose Postgres 手动验证检索测试台。

---

### Task 1: 契约扩展 — `rerankThreshold` 字段 + otel-conventions RAG 属性

**Files:**
- Modify: `packages/contracts/src/retrieval.ts`
- Modify: `packages/otel-conventions/src/index.ts`
- Modify: `packages/contracts/src/m2-schemas.test.ts`

- [ ] **Step 1: 写失败测试(m2-schemas.test.ts 加 rerankThreshold 边界值用例)**

在 `packages/contracts/src/m2-schemas.test.ts` 第 161-163 行(`RetrievalTestRequestSchema rejects threshold out of range`)之后插入:

```ts
it("RetrievalTestRequestSchema rejects rerankThreshold out of range", () => {
  expect(() =>
    RetrievalTestRequestSchema.parse({ ...valid.retrievalReq, rerankThreshold: 1.5 }),
  ).toThrow();
});
it("RetrievalTestRequestSchema accepts rerankThreshold within range", () => {
  expect(
    RetrievalTestRequestSchema.parse({ ...valid.retrievalReq, rerankThreshold: 0.5 }).rerankThreshold,
  ).toBe(0.5);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @codecrush/contracts test`
Expected: FAIL,`rerankThreshold` 不在 `RetrievalTestRequestSchema` 定义里,`.parse()` 会因为多传未知字段被 Zod 默认 strip 掉(不会抛错),第二个用例断言 `.rerankThreshold` 是 `undefined` 而非 `0.5`,导致断言失败。

- [ ] **Step 3: 实现 — 加字段**

`packages/contracts/src/retrieval.ts`,在 `RetrievalTestRequestSchema` 的 `topN` 字段后加:

```ts
export const RetrievalTestRequestSchema = z.object({
  query: z.string().min(1),
  kbId: z.string().min(1),
  embedModelId: z.string().min(1),
  topK: z.number().int().positive(),
  threshold: z.number().min(0).max(1),
  multi: z.boolean(),
  vecWeight: z.number().min(0).max(1).optional(),
  rerankModelId: z.string().optional(),
  rerankThreshold: z.number().min(0).max(1).optional(),
  topN: z.number().int().positive().optional(),
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @codecrush/contracts test`
Expected: PASS

- [ ] **Step 5: otel-conventions 加 RAG 属性(无测试,纯常量新增,`otel-conventions` 现有测试只做完整性快照,新增字段不破坏既有断言 — 跑一遍确认)**

`packages/otel-conventions/src/index.ts`,`RAG` 对象里 `PROMPT_VERSION_ID` 之后加:

```ts
export const RAG = {
  RETRIEVAL_TOP_K: "rag.retrieval.top_k",
  RETRIEVAL_TOP_N: "rag.retrieval.top_n",
  RETRIEVAL_THRESHOLD: "rag.retrieval.threshold",
  MULTI_RECALL: "rag.multi",
  CHUNK_SCORES: "rag.chunk.scores",
  CITATION_IDS: "rag.citation.ids",
  COST_USD: "rag.cost.usd",
  PROMPT_VERSION_ID: "rag.prompt.version_id",
  VEC_WEIGHT: "rag.retrieval.vec_weight",
  RERANK_THRESHOLD: "rag.rerank.threshold",
} as const;
```

Run: `pnpm --filter @codecrush/otel-conventions test`
Expected: PASS(现有测试是完整性/类型断言,新增 key 不影响)

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/retrieval.ts packages/contracts/src/m2-schemas.test.ts packages/otel-conventions/src/index.ts
git commit -m "feat(contracts): retrieval 契约加 rerankThreshold,otel-conventions 补 RAG 属性"
```

---

### Task 2: `RERANK_BUILDERS` — 5 协议请求构造/响应解析(纯函数)

**Files:**
- Create: `apps/backend/src/modules/models/adapters/rerank-builders.ts`
- Test: `apps/backend/test/rerank-builders.spec.ts`

- [ ] **Step 1: 写失败测试**

```ts
// apps/backend/test/rerank-builders.spec.ts
import { PROTOCOLS_BY_TYPE } from "@codecrush/contracts";
import { RERANK_BUILDERS } from "../src/modules/models/adapters/rerank-builders";
import type { ModelCallConfig } from "../src/modules/models/ports/model-provider.port";

const cfg = (over: Partial<ModelCallConfig> = {}): ModelCallConfig => ({
  type: "rerank",
  protocol: "cohere",
  name: "rerank-v3",
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test",
  params: {},
  ...over,
});

describe("RERANK_BUILDERS 表完整性", () => {
  it("每个 rerank 协议都有 builder，覆盖 5 个", () => {
    for (const protocol of PROTOCOLS_BY_TYPE.rerank) {
      expect(RERANK_BUILDERS[protocol]).toBeDefined();
    }
    expect(Object.keys(RERANK_BUILDERS)).toHaveLength(5);
  });
});

describe("cohere/jina rerank builder", () => {
  it("请求体含 query/documents/top_n，响应按 results[].relevance_score 解析", () => {
    const req = RERANK_BUILDERS.cohere(cfg(), "问题", ["文档A", "文档B"], 2);
    expect(req.url).toBe("https://api.example.com/v1/rerank");
    expect(req.body).toMatchObject({
      model: "rerank-v3",
      query: "问题",
      documents: ["文档A", "文档B"],
      top_n: 2,
    });
    expect(
      req.parseResponse({
        results: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.3 },
        ],
      }),
    ).toEqual([
      { index: 1, score: 0.9 },
      { index: 0, score: 0.3 },
    ]);
  });
});

describe("openai_compat rerank builder", () => {
  it("URL 是 /reranks，兼容 results 或 data 两种响应包裹字段", () => {
    const req = RERANK_BUILDERS.openai_compat(cfg({ protocol: "openai_compat" }), "q", ["a", "b"]);
    expect(req.url).toBe("https://api.example.com/v1/reranks");
    expect(req.parseResponse({ results: [{ index: 0, relevance_score: 0.5 }] })).toEqual([
      { index: 0, score: 0.5 },
    ]);
    expect(req.parseResponse({ data: [{ index: 0, relevance_score: 0.7 }] })).toEqual([
      { index: 0, score: 0.7 },
    ]);
  });
});

describe("dashscope rerank builder", () => {
  it("URL 是 text-rerank 端点，body 用 input/parameters 包裹，响应从 output.results 取", () => {
    const req = RERANK_BUILDERS.dashscope(cfg({ protocol: "dashscope" }), "q", ["a", "b"], 1);
    expect(req.url).toBe(
      "https://api.example.com/v1/services/rerank/text-rerank/text-rerank",
    );
    expect(req.body).toEqual({
      model: "rerank-v3",
      input: { query: "q", documents: ["a", "b"] },
      parameters: { top_n: 1 },
    });
    expect(
      req.parseResponse({ output: { results: [{ index: 0, relevance_score: 0.6 }] } }),
    ).toEqual([{ index: 0, score: 0.6 }]);
  });
});

describe("self_hosted (TEI) rerank builder", () => {
  it("body 是 {query, texts}，响应是顶层数组 [{index, score}]", () => {
    const req = RERANK_BUILDERS.self_hosted(cfg({ protocol: "self_hosted" }), "q", ["a"]);
    expect(req.body).toEqual({ query: "q", texts: ["a"] });
    expect(req.parseResponse([{ index: 0, score: 0.42 }])).toEqual([{ index: 0, score: 0.42 }]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @codecrush/backend test rerank-builders`
Expected: FAIL,`Cannot find module '../src/modules/models/adapters/rerank-builders'`

- [ ] **Step 3: 实现**

```ts
// apps/backend/src/modules/models/adapters/rerank-builders.ts
import type { ModelProtocol } from "@codecrush/contracts";
import { bearerHeaders, isObj, joinUrl, modelId } from "./protocols/types";
import type { ModelCallConfig } from "../ports/model-provider.port";

/**
 * 批量重排请求描述：builder 是纯函数，只负责按协议构造请求体与响应解析。
 * fetch / 超时 /密钥擦除统一在 ProtocolDispatchAdapter.rerank()（同 EMBED_BUILDERS 的分工）。
 */
export interface RerankRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  parseResponse: (json: unknown) => { index: number; score: number }[];
}

export type RerankBuilder = (
  config: ModelCallConfig,
  query: string,
  documents: string[],
  topN?: number,
) => RerankRequest;

// {results:[{index, relevance_score}]} 是 cohere/jina/openai_compat(results 分支)共用形态
function parseResultsField(json: unknown): { index: number; score: number }[] {
  if (!isObj(json) || !Array.isArray(json.results)) return [];
  return (json.results as Array<Record<string, unknown>>).map((r) => ({
    index: Number(r.index),
    score: Number(r.relevance_score ?? r.score),
  }));
}

// (protocol) → 批量重排 builder 表：与契约 PROTOCOLS_BY_TYPE.rerank 的 5 个协议一一对应
// （完整性由 rerank-builders.spec 断言，同 EMBED_BUILDERS 的查表+防御分支模式）。
// llm/embedding-only 协议（anthropic/gemini）不在表内：ProtocolDispatchAdapter.rerank() 对查不到
// builder 的情况有防御分支——契约层已收口 rerank 合法协议，此分支正常不可达。
export const RERANK_BUILDERS: Record<ModelProtocol, RerankBuilder> = {
  self_hosted: (c, query, documents) => ({
    url: joinUrl(c.baseUrl, "/rerank"),
    headers: bearerHeaders(c.apiKey),
    body: { query, texts: documents },
    parseResponse: (json) =>
      Array.isArray(json)
        ? (json as Array<{ index: number; score: number }>).map((r) => ({
            index: r.index,
            score: r.score,
          }))
        : [],
  }),
  openai_compat: (c, query, documents, topN) => ({
    url: joinUrl(c.baseUrl, "/reranks"),
    headers: bearerHeaders(c.apiKey),
    body: { model: modelId(c), query, documents, top_n: topN ?? documents.length },
    // 阿里云百炼等兼容网关可能用 results 或 data 包裹，两个字段名都要能解析
    parseResponse: (json) => {
      const viaResults = parseResultsField(json);
      if (viaResults.length) return viaResults;
      if (isObj(json) && Array.isArray(json.data)) {
        return (json.data as Array<Record<string, unknown>>).map((r) => ({
          index: Number(r.index),
          score: Number(r.relevance_score ?? r.score),
        }));
      }
      return [];
    },
  }),
  cohere: (c, query, documents, topN) => ({
    url: joinUrl(c.baseUrl, "/rerank"),
    headers: bearerHeaders(c.apiKey),
    body: { model: modelId(c), query, documents, top_n: topN ?? documents.length },
    parseResponse: parseResultsField,
  }),
  jina: (c, query, documents, topN) => ({
    url: joinUrl(c.baseUrl, "/rerank"),
    headers: bearerHeaders(c.apiKey),
    body: { model: modelId(c), query, documents, top_n: topN ?? documents.length },
    parseResponse: parseResultsField,
  }),
  dashscope: (c, query, documents, topN) => ({
    url: joinUrl(c.baseUrl, "/services/rerank/text-rerank/text-rerank"),
    headers: bearerHeaders(c.apiKey),
    body: {
      model: modelId(c),
      input: { query, documents },
      parameters: { top_n: topN ?? documents.length },
    },
    parseResponse: (json) => {
      if (!isObj(json) || !isObj(json.output)) return [];
      return parseResultsField(json.output);
    },
  }),
} as Record<string, RerankBuilder>;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @codecrush/backend test rerank-builders`
Expected: PASS,8 个用例全绿

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/models/adapters/rerank-builders.ts apps/backend/test/rerank-builders.spec.ts
git commit -m "feat(models): 加 RERANK_BUILDERS，5 协议请求构造/响应解析"
```

---

### Task 3: `ModelProviderPort.rerank()` + `ProtocolDispatchAdapter` 接线

**Files:**
- Modify: `apps/backend/src/modules/models/ports/model-provider.port.ts`
- Modify: `apps/backend/src/modules/models/adapters/protocol-dispatch.adapter.ts`
- Modify: `apps/backend/test/protocol-dispatch.adapter.spec.ts`

- [ ] **Step 1: 写失败测试**

该文件顶部已有共享的 `cfg`/`okJson`/`lastCall` 辅助函数(第 1-23 行)与 `describe("ProtocolDispatchAdapter.embed", ...)`(第 176-233 行)——新的 `rerank` describe 块照抄 `embed` 块的 `fetchMock`/`beforeEach` 结构与超时用例的**真实 fake-timer 写法**(第 215-232 行的 `jest.useFakeTimers()` + `abort` 事件监听 + `jest.advanceTimersByTimeAsync()`，不是 `setTimeout`)。在文件 `import` 区加 `RERANK_TIMEOUT_MS`：

```ts
import {
  PROBE_BUILDERS,
  ProtocolDispatchAdapter,
  RERANK_TIMEOUT_MS,
} from "../src/modules/models/adapters/protocol-dispatch.adapter";
```

在 `describe("ProtocolDispatchAdapter.embed", ...)` 块(结束于第 233 行)之后加:

```ts
describe("ProtocolDispatchAdapter.rerank", () => {
  const adapter = new ProtocolDispatchAdapter();
  const rerankCfg = () => cfg({ type: "rerank", protocol: "cohere", name: "rerank-v3" });
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("成功：返回解析出的 results", async () => {
    fetchMock.mockResolvedValue(okJson({ results: [{ index: 0, relevance_score: 0.8 }] }));
    const res = await adapter.rerank(rerankCfg(), "q", ["a"]);
    expect(res.results).toEqual([{ index: 0, score: 0.8 }]);
  });

  it("非 2xx → 抛错，附带脱敏后的上游 message", async () => {
    fetchMock.mockResolvedValue(okJson({ error: { message: "boom" } }, 500));
    await expect(adapter.rerank(rerankCfg(), "q", ["a"])).rejects.toThrow(/HTTP 500/);
  });

  // 回归同 embed() 的 P2-6 超时保护（同一文件第 212-232 行）：fetch 挂起超过
  // RERANK_TIMEOUT_MS → abort 并抛超时错误，不会永久挂起。
  it("fetch 挂起超过 RERANK_TIMEOUT_MS → abort 并抛超时错误，不会永久挂起", async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, opts: RequestInit) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );
    const pending = adapter.rerank(rerankCfg(), "q", ["a"]);
    const assertion = expect(pending).rejects.toThrow(/rerank 请求超时/);
    await jest.advanceTimersByTimeAsync(RERANK_TIMEOUT_MS);
    await assertion;
    jest.useRealTimers();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @codecrush/backend test protocol-dispatch.adapter`
Expected: FAIL,`adapter.rerank is not a function`

- [ ] **Step 3: 实现 — port 接口加方法**

`apps/backend/src/modules/models/ports/model-provider.port.ts`:

```ts
export interface RerankResult {
  results: { index: number; score: number }[];
}

export interface ModelProviderPort {
  testConnection(config: ModelCallConfig): Promise<TestModelResult>;
  embed(config: ModelCallConfig, texts: string[]): Promise<EmbedResult>;
  rerank(
    config: ModelCallConfig,
    query: string,
    documents: string[],
    topN?: number,
  ): Promise<RerankResult>;
}
```

- [ ] **Step 4: 实现 — adapter 加 `rerank()`**

`apps/backend/src/modules/models/adapters/protocol-dispatch.adapter.ts`,在 `EMBED_TIMEOUT_MS` 常量后加:

```ts
// rerank 在检索的同步用户路径上（008 §Requirements），不能沿用 embed() 的 60s 异步预算；
// 5s 是介于「测试连接」10s 探针与 chat 端 30s 熔断之间的工程估计，未经真实供应商实测校准
// （008 Revisit：接入真实供应商后需要重新量）。
export const RERANK_TIMEOUT_MS = 5_000;
```

`import` 区加 `import { RERANK_BUILDERS } from "./rerank-builders";` 与 `import type { RerankResult } from "../ports/model-provider.port";`，`class ProtocolDispatchAdapter` 内 `embed()` 方法之后加:

```ts
async rerank(
  config: ModelCallConfig,
  query: string,
  documents: string[],
  topN?: number,
): Promise<RerankResult> {
  const builder = RERANK_BUILDERS[config.protocol];
  if (!builder) {
    // 契约层已收口 rerank 合法协议组合，此分支正常不可达（防御新枚举值漏配 builder）
    throw new Error(`unsupported protocol ${config.protocol} for rerank`);
  }
  const req = builder(config, query, documents, topN);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RERANK_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: controller.signal,
    });
  } catch (err) {
    const message = controller.signal.aborted
      ? `rerank 请求超时（>${RERANK_TIMEOUT_MS}ms）`
      : err instanceof Error
        ? err.message
        : String(err);
    throw new Error(redactSecret(message, config.apiKey));
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const json: unknown = await resp.json().catch(() => undefined);
    throw new Error(redactSecret(upstreamError(resp.status, json), config.apiKey));
  }
  const json = await resp.json();
  return { results: req.parseResponse(json) };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @codecrush/backend test protocol-dispatch.adapter`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/modules/models/ports/model-provider.port.ts apps/backend/src/modules/models/adapters/protocol-dispatch.adapter.ts apps/backend/test/protocol-dispatch.adapter.spec.ts
git commit -m "feat(models): ProtocolDispatchAdapter 实现 rerank()，5s 超时降级不抛"
```

---

### Task 4: `ModelsService.rerankTexts()`

**Files:**
- Modify: `apps/backend/src/modules/models/models.service.ts`
- Modify: `apps/backend/test/models.service.spec.ts`

- [ ] **Step 1: 写失败测试**

**先核实两件事再写**（此前草稿曾错误假设了不存在的东西）：该文件目前**没有** `embedTexts` 的既有用例可抄；`ModelsService` 真实构造函数参数顺序是 `(repo, enc, provider)`（`models.service.ts:41-45`），不是 `(repo, provider, enc)`；文件顶部已有可复用的 `makeRepo()` 工厂函数(第 10-42 行)和 `enc = new EncryptionService(...)`(第 8 行)，`svc.create(...)` 是给 mock repo 灌真实（加密后的）行的标准手法，不需要手写 `apiKeyEnc` fixture。

在文件末尾(最后一个 `describe` 块之后)加:

```ts
describe("ModelsService.rerankTexts", () => {
  it("查行、解密 key、调用 provider.rerank，返回 results", async () => {
    const repo = makeRepo();
    const rerankPort = {
      testConnection: jest.fn(),
      embed: jest.fn(),
      rerank: jest.fn(async () => ({ results: [{ index: 0, score: 0.9 }] })),
    } as unknown as ModelProviderPort;
    const svc = new ModelsService(repo as unknown as ModelsRepository, enc, rerankPort);
    const created = await svc.create({
      type: "rerank",
      protocol: "cohere",
      name: "rerank-v3",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-rerank12345",
      params: {},
      enabled: true,
    });
    const results = await svc.rerankTexts(created.id, "问题", ["a", "b"], 5);
    expect(results).toEqual([{ index: 0, score: 0.9 }]);
    expect(rerankPort.rerank).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-rerank12345", protocol: "cohere" }),
      "问题",
      ["a", "b"],
      5,
    );
  });
});
```

（用局部 `rerankPort` 而不是复用文件顶部共享的 `port` 常量：共享 `port` 目前只声明了 `testConnection`，本任务不改动它，避免打乱其它既有用例。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @codecrush/backend test models.service`
Expected: FAIL,`svc.rerankTexts is not a function`

- [ ] **Step 3: 实现**

`apps/backend/src/modules/models/models.service.ts`，在 `embedTexts()` 方法之后加:

```ts
// 供 retrieval 域调用：按 modelId 查行、解密 key、调端口 rerank()。密钥解密不出 models 域
// （同 embedTexts 的模式，008 §Rerank 端口设计）。
async rerankTexts(
  modelId: string,
  query: string,
  texts: string[],
  topN?: number,
): Promise<{ index: number; score: number }[]> {
  const row = await this.mustFind(modelId);
  const { results } = await this.provider.rerank(
    {
      type: row.type as ModelType,
      protocol: row.protocol as ModelProtocol,
      name: row.name,
      baseUrl: row.baseUrl,
      deploymentId: row.deploymentId ?? undefined,
      params: row.params,
      apiKey: this.enc.decrypt(row.apiKeyEnc),
    },
    query,
    texts,
    topN,
  );
  return results;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @codecrush/backend test models.service`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/models/models.service.ts apps/backend/test/models.service.spec.ts
git commit -m "feat(models): ModelsService 加 rerankTexts()"
```

---

### Task 5: `chunks.tsv` 生成列迁移

**Files:**
- Create: `apps/backend/drizzle/0008_m5_chunks_tsv.sql`(编号紧接现有最新 `0007_wide_giant_girl.sql`；实际文件名/drizzle 自动生成的随机后缀由 Step 1 的探测结果决定)
- Modify: `apps/backend/drizzle/meta/_journal.json`
- Modify: `apps/backend/src/modules/chunks/schema.ts`

- [ ] **Step 1: 探测 `drizzle-kit` 对生成列的支持情况**

Run: `cd apps/backend && npx drizzle-kit generate --help`

检查输出是否支持 `--custom`(生成空迁移文件供手写 SQL)。**预期支持**(drizzle-kit 现代版本都有 `--custom` 选项)；若不支持，改为直接手写 `.sql` 文件 + 手动在 `meta/_journal.json` 追加一条 entry(仿照现有 idx 7 的写法，`idx:8, tag:"0008_m5_chunks_tsv", when:` 用当前时间戳)。

- [ ] **Step 2: 生成/手写迁移文件**

Run(若 `--custom` 可用): `npx drizzle-kit generate --custom --name=m5_chunks_tsv`

文件内容(`apps/backend/drizzle/0008_m5_chunks_tsv.sql`，已在真实 Postgres 容器验证过 `to_tsvector` + `GENERATED ALWAYS AS ... STORED` 的组合可行，见 008 §中文分词方案):

```sql
-- cjk_bigram_text：中文字符两两重叠切分，非中文字符原样保留；
-- 供 tsv 生成列与 searchByKeyword 查询侧共用（避免 TS/SQL 两处重复分词逻辑）。
CREATE OR REPLACE FUNCTION cjk_bigram_text(input text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT string_agg(
    CASE
      WHEN substr(input, i, 1) ~ '[一-鿿]' AND i < length(input)
        THEN substr(input, i, 2)
      ELSE substr(input, i, 1)
    END, ' ')
  FROM generate_series(1, length(input)) AS i;
$$;
--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', cjk_bigram_text("text"))) STORED;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chunks_tsv_gin_idx" ON "chunks" USING gin ("tsv");
```

- [ ] **Step 3: `schema.ts` 加类型声明(供 TS 查询构造用，DDL 已由上面的手写迁移负责，不需要 `drizzle-kit generate` 从 schema.ts 推导)**

`apps/backend/src/modules/chunks/schema.ts`，`import` 区加 `import { customType } from "drizzle-orm/pg-core";`(若 `pg-core` 里 tsvector 无内置类型，用 `customType` 声明只读列)：

```ts
const tsvectorColumn = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});
```

`chunks` 表定义里 `embedding` 列之后加:

```ts
    // GENERATED ALWAYS AS ... STORED 列（迁移 0008），Drizzle 只需要知道类型用于查询构造，
    // 不在这里声明 .generatedAlwaysAs()（drizzle-kit generate 对生成列表达式的自动推导不可靠，
    // DDL 权威落在手写迁移文件，这里只是类型声明，与 embedding 列走 HNSW 手写索引同一先例）。
    tsv: tsvectorColumn("tsv"),
```

- [ ] **Step 4: 迁移应用与验证**

Run: `docker compose -f infra/docker-compose.yml --profile infra up -d --wait`(确保本地 Postgres 在跑)
Run: `pnpm --filter @codecrush/backend db:migrate`
Expected: 迁移成功无报错。

Run(手动验证，非自动化测试，呼应本 plan 顶部的测试策略确认):
```bash
docker exec codecrush-postgres-1 psql -U codecrush -d codecrush -c "\d chunks" | grep tsv
docker exec codecrush-postgres-1 psql -U codecrush -d codecrush -c "SELECT cjk_bigram_text('测试中文分词效果');"
```
Expected: `tsv` 列存在，类型 `tsvector`；`cjk_bigram_text` 输出 `测试 试中 中文 文分 分词 词效 效果 果`。

- [ ] **Step 5: Commit**

```bash
git add apps/backend/drizzle/0008_m5_chunks_tsv.sql apps/backend/drizzle/meta/_journal.json apps/backend/src/modules/chunks/schema.ts
git commit -m "feat(chunks): 加 tsv 生成列 + GIN 索引，中文 bigram 预处理"
```

---

### Task 6: `ChunksRepository.searchByVector` / `searchByKeyword`

**Files:**
- Modify: `apps/backend/src/modules/chunks/chunks.repository.ts`

不新增单测(Task 5 的测试策略确认：仓储方法不单测，沿用本项目既有先例)。

- [ ] **Step 1: 实现**

`apps/backend/src/modules/chunks/chunks.repository.ts`，`import` 区加 `import { documents } from "../documents/schema";`，在 `deleteByVersion()` 方法之后加:

```ts
export interface VectorCandidate {
  chunkId: string;
  docId: string;
  docName: string;
  text: string;
  section: string;
  vecScore: number;
}

export interface KeywordCandidate {
  chunkId: string;
  docId: string;
  docName: string;
  text: string;
  section: string;
  kwScore: number;
}
```

`class ChunksRepository` 内加两个方法:

```ts
// 向量召回：pgvector <=> 是 cosine distance（HNSW 索引 vector_cosine_ops 已在 migration 0006 建好），
// 1 - distance 换算成 [0,1] 的相似度分数（008 §数据流程图）。leftJoin documents 直接带出 docName，
// 不新增 retrieval→documents 依赖边（chunks 模块本来就 import DocumentsModule，schema.ts 已引用
// documents 表对象，diff-report.md 修正 2 已核实）。
async searchByVector(
  kbId: string,
  version: number,
  embedding: number[],
  limit: number,
): Promise<VectorCandidate[]> {
  const vecLiteral = `[${embedding.join(",")}]`;
  const rows = await this.db
    .select({
      chunkId: chunks.id,
      docId: chunks.docId,
      docName: documents.name,
      text: chunks.text,
      section: chunks.section,
      vecScore: sql<number>`1 - (${chunks.embedding} <=> ${vecLiteral}::vector)`,
    })
    .from(chunks)
    .leftJoin(documents, eq(chunks.docId, documents.id))
    .where(and(eq(chunks.kbId, kbId), eq(chunks.version, version)))
    .orderBy(sql`${chunks.embedding} <=> ${vecLiteral}::vector`)
    .limit(limit);
  return rows.map((r) => ({ ...r, docName: r.docName ?? "", vecScore: Number(r.vecScore) }));
}

// 关键词召回：query 与索引侧共用 cjk_bigram_text（migration 0008），OR 连接 bigram token
// 构造 tsquery（避免任何单字差异导致零命中），ts_rank_cd(...,32) 内置归一化到 [0,1)
// （008 §kwScore 归一化，rank/(rank+1)，不依赖候选池组成，跨查询可比较）。
async searchByKeyword(
  kbId: string,
  version: number,
  query: string,
  limit: number,
): Promise<KeywordCandidate[]> {
  const tsq = sql`to_tsquery('simple', regexp_replace(cjk_bigram_text(${query}), '\s+', ' | ', 'g'))`;
  const rankExpr = sql<number>`ts_rank_cd(${chunks.tsv}, ${tsq}, 32)`;
  const rows = await this.db
    .select({
      chunkId: chunks.id,
      docId: chunks.docId,
      docName: documents.name,
      text: chunks.text,
      section: chunks.section,
      kwScore: rankExpr,
    })
    .from(chunks)
    .leftJoin(documents, eq(chunks.docId, documents.id))
    .where(and(eq(chunks.kbId, kbId), eq(chunks.version, version), sql`${chunks.tsv} @@ ${tsq}`))
    .orderBy(sql`${rankExpr} DESC`)
    .limit(limit);
  return rows.map((r) => ({ ...r, docName: r.docName ?? "", kwScore: Number(r.kwScore) }));
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm --filter @codecrush/backend build`(或 `tsc --noEmit`，按项目现有类型检查命令)
Expected: 通过，无 TS 报错。`sql<number>` 泛型标注需要与 drizzle-orm 当前版本的 `sql` 模板签名匹配——若类型检查报错，对照 `chunks.repository.ts` 里 `countByDocs`/`countByKbVersions` 已有的 `sql<number>\`count(*)::int\`` 写法调整。

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/modules/chunks/chunks.repository.ts
git commit -m "feat(chunks): ChunksRepository 加 searchByVector/searchByKeyword"
```

---

### Task 7: `ChunksService` 薄透传方法

**Files:**
- Modify: `apps/backend/src/modules/chunks/chunks.service.ts`

- [ ] **Step 1: 实现(无需新测试——纯透传，`retrieval.service.spec.ts`/`pg-hybrid-retriever.adapter.spec.ts` 会 mock 这两个方法间接验证调用形状)**

`apps/backend/src/modules/chunks/chunks.service.ts`，`import` 区加 `import type { VectorCandidate, KeywordCandidate } from "./chunks.repository";`，`class ChunksService` 内 `batchDelete()` 方法之后加:

```ts
// 薄透传：retrieval 经此 barrel 调用，不直接注入 ChunksRepository（008 §模块边界，
// 即便 ChunksModule 的 exports 数组里两者都在，跨模块调用意图上走 service）。
async searchByVector(
  kbId: string,
  version: number,
  embedding: number[],
  limit: number,
): Promise<VectorCandidate[]> {
  return this.chunksRepo.searchByVector(kbId, version, embedding, limit);
}

async searchByKeyword(
  kbId: string,
  version: number,
  query: string,
  limit: number,
): Promise<KeywordCandidate[]> {
  return this.chunksRepo.searchByKeyword(kbId, version, query, limit);
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm --filter @codecrush/backend build`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/modules/chunks/chunks.service.ts
git commit -m "feat(chunks): ChunksService 加 searchByVector/searchByKeyword 薄透传"
```

---

### Task 8: `RetrieverPort` + `PgHybridRetriever`(核心编排逻辑)

**Files:**
- Create: `apps/backend/src/modules/retrieval/retriever.constants.ts`
- Create: `apps/backend/src/modules/retrieval/ports/retriever.port.ts`
- Create: `apps/backend/src/modules/retrieval/adapters/pg-hybrid-retriever.adapter.ts`
- Test: `apps/backend/test/pg-hybrid-retriever.adapter.spec.ts`

这是全部业务逻辑(融合/降级/阈值语义/候选池上限)所在，是本次实现里测试覆盖最重的一块。

- [ ] **Step 1: 写失败测试**

```ts
// apps/backend/test/pg-hybrid-retriever.adapter.spec.ts
import { PgHybridRetriever } from "../src/modules/retrieval/adapters/pg-hybrid-retriever.adapter";
import type { ChunksService } from "../src/modules/chunks/chunks.service";
import type { ModelsService } from "../src/modules/models/models.service";
import type { KnowledgeBasesService } from "../src/modules/knowledge-bases/knowledge-bases.service";

const kb = { id: "kb1", activeVersion: 3 };
const baseReq = {
  query: "退货政策",
  kbId: "kb1",
  embedModelId: "m2",
  topK: 10,
  threshold: 0.5,
  multi: true,
};

function makeDeps(overrides: {
  vecRows?: unknown[];
  kwRows?: unknown[];
  vecFails?: boolean;
  kwFails?: boolean;
  rerankResults?: unknown[];
  rerankFails?: boolean;
} = {}) {
  const chunks = {
    searchByVector: jest.fn(async () => {
      if (overrides.vecFails) throw new Error("vector down");
      return overrides.vecRows ?? [];
    }),
    searchByKeyword: jest.fn(async () => {
      if (overrides.kwFails) throw new Error("keyword down");
      return overrides.kwRows ?? [];
    }),
  } as unknown as ChunksService;
  const models = {
    embedTexts: jest.fn(async () => [[0.1, 0.2]]),
    rerankTexts: jest.fn(async () => {
      if (overrides.rerankFails) throw new Error("rerank down");
      return overrides.rerankResults ?? [];
    }),
  } as unknown as ModelsService;
  const kbs = { get: jest.fn(async () => kb) } as unknown as KnowledgeBasesService;
  return { chunks, models, kbs };
}

describe("PgHybridRetriever.retrieve — 融合与阈值", () => {
  it("multi=false 时 finalScore = vecScore，不查关键词路", async () => {
    const { chunks, models, kbs } = makeDeps({
      vecRows: [{ chunkId: "c1", docId: "d1", docName: "doc1", text: "t", section: "s", vecScore: 0.9 }],
    });
    const retriever = new PgHybridRetriever(chunks, models, kbs);
    const hits = await retriever.retrieve({ ...baseReq, multi: false });
    expect(chunks.searchByKeyword).not.toHaveBeenCalled();
    expect(hits).toEqual([
      expect.objectContaining({ chunkId: "c1", vecScore: 0.9, kwScore: undefined, finalScore: 0.9 }),
    ]);
  });

  it("multi=true 时 finalScore = 加权线性和，权重默认 0.5", async () => {
    const { chunks, models, kbs } = makeDeps({
      vecRows: [{ chunkId: "c1", docId: "d1", docName: "doc1", text: "t", section: "s", vecScore: 0.8 }],
      kwRows: [{ chunkId: "c1", docId: "d1", docName: "doc1", text: "t", section: "s", kwScore: 0.4 }],
    });
    const retriever = new PgHybridRetriever(chunks, models, kbs);
    const [hit] = await retriever.retrieve({ ...baseReq, threshold: 0 });
    expect(hit.finalScore).toBeCloseTo(0.8 * 0.5 + 0.4 * 0.5, 5);
  });

  it("只被关键词路召回的 chunk，vecScore 缺省按 0 参与融合", async () => {
    const { chunks, models, kbs } = makeDeps({
      vecRows: [],
      kwRows: [{ chunkId: "c2", docId: "d2", docName: "doc2", text: "t2", section: "s", kwScore: 0.6 }],
    });
    const retriever = new PgHybridRetriever(chunks, models, kbs);
    const [hit] = await retriever.retrieve({ ...baseReq, vecWeight: 0.5, threshold: 0 });
    expect(hit.finalScore).toBeCloseTo(0 * 0.5 + 0.6 * 0.5, 5);
  });

  it("相似度阈值过滤：finalScore 低于 threshold 的候选被剔除", async () => {
    const { chunks, models, kbs } = makeDeps({
      vecRows: [{ chunkId: "c1", docId: "d1", docName: "doc1", text: "t", section: "s", vecScore: 0.2 }],
    });
    const retriever = new PgHybridRetriever(chunks, models, kbs);
    const hits = await retriever.retrieve({ ...baseReq, multi: false, threshold: 0.5 });
    expect(hits).toEqual([]);
  });
});

describe("PgHybridRetriever.retrieve — rerank 分支", () => {
  it("rerank 成功：finalScore 覆盖为 rerankScore，按 rerankThreshold 再过滤一次", async () => {
    const { chunks, models, kbs } = makeDeps({
      vecRows: [
        { chunkId: "c1", docId: "d1", docName: "doc1", text: "t1", section: "s", vecScore: 0.9 },
        { chunkId: "c2", docId: "d2", docName: "doc2", text: "t2", section: "s", vecScore: 0.8 },
      ],
      rerankResults: [
        { index: 0, score: 0.3 },
        { index: 1, score: 0.95 },
      ],
    });
    const retriever = new PgHybridRetriever(chunks, models, kbs);
    const hits = await retriever.retrieve({
      ...baseReq,
      multi: false,
      threshold: 0,
      rerankModelId: "rr1",
      rerankThreshold: 0.5,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual(
      expect.objectContaining({ chunkId: "c2", rerankScore: 0.95, finalScore: 0.95 }),
    );
  });

  it("rerank 失败/超时 → 降级跳过，finalScore 保留融合分，不抛出", async () => {
    const { chunks, models, kbs } = makeDeps({
      vecRows: [{ chunkId: "c1", docId: "d1", docName: "doc1", text: "t", section: "s", vecScore: 0.9 }],
      rerankFails: true,
    });
    const retriever = new PgHybridRetriever(chunks, models, kbs);
    const hits = await retriever.retrieve({
      ...baseReq,
      multi: false,
      threshold: 0,
      rerankModelId: "rr1",
    });
    expect(hits[0]).toEqual(
      expect.objectContaining({ chunkId: "c1", finalScore: 0.9, rerankScore: undefined }),
    );
  });
});

describe("PgHybridRetriever.retrieve — 降级路径", () => {
  it("向量召回失败 → 硬失败，抛出", async () => {
    const { chunks, models, kbs } = makeDeps({ vecFails: true });
    const retriever = new PgHybridRetriever(chunks, models, kbs);
    await expect(retriever.retrieve(baseReq)).rejects.toThrow();
  });

  it("关键词召回失败 → 降级为纯向量继续，不抛出", async () => {
    const { chunks, models, kbs } = makeDeps({
      vecRows: [{ chunkId: "c1", docId: "d1", docName: "doc1", text: "t", section: "s", vecScore: 0.9 }],
      kwFails: true,
    });
    const retriever = new PgHybridRetriever(chunks, models, kbs);
    const hits = await retriever.retrieve({ ...baseReq, threshold: 0 });
    expect(hits[0]).toEqual(expect.objectContaining({ chunkId: "c1", finalScore: 0.9 }));
  });
});

describe("PgHybridRetriever.retrieve — 候选池上限与 topN", () => {
  it("topK 低于平台上限时，召回池大小就是 topK 本身（不是恒等于上限）", async () => {
    const { chunks, models, kbs } = makeDeps();
    const retriever = new PgHybridRetriever(chunks, models, kbs);
    await retriever.retrieve({ ...baseReq, topK: 5 });
    const [, , , limitArg] = (chunks.searchByVector as jest.Mock).mock.calls[0];
    expect(limitArg).toBe(5);
  });

  it("topK 超过平台上限时，召回池大小被封顶（不随 topK 无界增长）", async () => {
    const { chunks, models, kbs } = makeDeps();
    const retriever = new PgHybridRetriever(chunks, models, kbs);
    await retriever.retrieve({ ...baseReq, topK: 500 });
    const [, , , limitArg] = (chunks.searchByVector as jest.Mock).mock.calls[0];
    expect(limitArg).toBeLessThanOrEqual(100);
    expect(limitArg).toBeLessThan(500);
  });

  it("kb.activeVersion 被用于两路召回的 version 参数", async () => {
    const { chunks, models, kbs } = makeDeps();
    const retriever = new PgHybridRetriever(chunks, models, kbs);
    await retriever.retrieve(baseReq);
    expect(chunks.searchByVector).toHaveBeenCalledWith("kb1", 3, expect.anything(), expect.anything());
  });

  it("topN 截断最终结果", async () => {
    const { chunks, models, kbs } = makeDeps({
      vecRows: [
        { chunkId: "c1", docId: "d1", docName: "d", text: "t", section: "s", vecScore: 0.9 },
        { chunkId: "c2", docId: "d2", docName: "d", text: "t", section: "s", vecScore: 0.8 },
      ],
    });
    const retriever = new PgHybridRetriever(chunks, models, kbs);
    const hits = await retriever.retrieve({ ...baseReq, multi: false, threshold: 0, topN: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0].chunkId).toBe("c1");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @codecrush/backend test pg-hybrid-retriever`
Expected: FAIL,`Cannot find module '../src/modules/retrieval/adapters/pg-hybrid-retriever.adapter'`

- [ ] **Step 3: 实现 — port 接口**

```ts
// apps/backend/src/modules/retrieval/ports/retriever.port.ts
import type { RetrievalHit, RetrievalTestRequest } from "@codecrush/contracts";

// 001「RetrieverPort.retrieve(query, opts)」的落地：复用 RetrievalTestRequest 作为单一入参
// （query 已内嵌在其中），避免与该 DTO 近乎重复定义第二个类型——chat（M8）与检索测试台
// 共用同一个端口/同一个入参形状，不是两套实现。
export interface RetrieverPort {
  retrieve(req: RetrievalTestRequest): Promise<RetrievalHit[]>;
}
```

```ts
// apps/backend/src/modules/retrieval/retriever.constants.ts
export const RETRIEVER_PORT = Symbol("RETRIEVER_PORT");
```

- [ ] **Step 4: 实现 — `PgHybridRetriever`**

```ts
// apps/backend/src/modules/retrieval/adapters/pg-hybrid-retriever.adapter.ts
import { Injectable } from "@nestjs/common";
import type { RetrievalHit, RetrievalTestRequest } from "@codecrush/contracts";
import { ChunksService } from "../../chunks/chunks.service";
import { ModelsService } from "../../models/models.service";
import { KnowledgeBasesService } from "../../knowledge-bases/knowledge-bases.service";
import type { RetrieverPort } from "../ports/retriever.port";

// 平台级重排候选池上限，独立于用户可自由输入的 topK（008 §性能/规模），防止重排调用成本
// 随 topK 无界增长。50–100 是工程判断，未经真实供应商实测校准（008 Revisit）。
const RERANK_POOL_CAP = 80;

interface FusedCandidate {
  chunkId: string;
  docId: string;
  docName: string;
  text: string;
  section: string;
  vecScore: number;
  kwScore?: number;
  rerankScore?: number;
  finalScore: number;
}

@Injectable()
export class PgHybridRetriever implements RetrieverPort {
  constructor(
    private readonly chunks: ChunksService,
    private readonly models: ModelsService,
    private readonly kbs: KnowledgeBasesService,
  ) {}

  async retrieve(req: RetrievalTestRequest): Promise<RetrievalHit[]> {
    const kb = await this.kbs.get(req.kbId);
    const [queryVector] = await this.models.embedTexts(req.embedModelId, [req.query]);

    const vecWeight = req.vecWeight ?? 0.5;
    const poolSize = Math.min(req.topK, RERANK_POOL_CAP);

    const [vecOutcome, kwOutcome] = await Promise.allSettled([
      this.chunks.searchByVector(req.kbId, kb.activeVersion, queryVector, poolSize),
      req.multi
        ? this.chunks.searchByKeyword(req.kbId, kb.activeVersion, req.query, poolSize)
        : Promise.resolve([]),
    ]);

    // 向量召回是核心信号，无先例支持降级（008 Invariant 3，非对称降级）
    if (vecOutcome.status === "rejected") {
      throw new Error(`向量召回失败：${(vecOutcome.reason as Error).message}`);
    }
    const vecRows = vecOutcome.value;
    // 关键词召回失败 → 降级为纯向量继续（001 既定先例），静默丢弃本路结果
    const kwRows = req.multi && kwOutcome.status === "fulfilled" ? kwOutcome.value : [];

    const fused = this.fuse(vecRows, kwRows, vecWeight)
      .filter((c) => c.finalScore >= req.threshold)
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, poolSize);

    let candidates = fused;
    if (req.rerankModelId && candidates.length > 0) {
      try {
        const rerankResults = await this.models.rerankTexts(
          req.rerankModelId,
          req.query,
          candidates.map((c) => c.text),
        );
        const byIndex = new Map(rerankResults.map((r) => [r.index, r.score]));
        candidates = candidates.map((c, i) => {
          const score = byIndex.get(i);
          return score === undefined ? c : { ...c, rerankScore: score, finalScore: score };
        });
        if (req.rerankThreshold !== undefined) {
          candidates = candidates.filter(
            (c) => c.rerankScore === undefined || c.rerankScore >= req.rerankThreshold!,
          );
        }
      } catch {
        // rerank 失败/超时 → 降级为跳过，保留融合分作为 finalScore（008 Invariant 3）
      }
    }

    const topN = req.topN ?? candidates.length;
    return candidates
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, topN)
      .map((c) => ({
        chunkId: c.chunkId,
        docId: c.docId,
        docName: c.docName,
        text: c.text,
        section: c.section,
        vecScore: c.vecScore,
        kwScore: c.kwScore,
        rerankScore: c.rerankScore,
        finalScore: c.finalScore,
      }));
  }

  // 加权线性和（不是 RRF——008 §融合算法：finalScore 已被契约锁死 [0,1]，凸组合天然满足，
  // RRF 还要再套一层归一化）。缺席某一路的 chunk，该路分数按 0 参与融合（未被该路召回=
  // 该路贡献为 0，是"候选池限定召回"的自然推论，不是刻意惩罚）。
  private fuse(
    vecRows: { chunkId: string; docId: string; docName: string; text: string; section: string; vecScore: number }[],
    kwRows: { chunkId: string; docId: string; docName: string; text: string; section: string; kwScore: number }[],
    vecWeight: number,
  ): FusedCandidate[] {
    const byId = new Map<string, FusedCandidate>();
    for (const r of vecRows) {
      byId.set(r.chunkId, { ...r, vecScore: r.vecScore, finalScore: r.vecScore });
    }
    for (const r of kwRows) {
      const existing = byId.get(r.chunkId);
      if (existing) {
        existing.kwScore = r.kwScore;
      } else {
        byId.set(r.chunkId, { ...r, vecScore: 0, kwScore: r.kwScore, finalScore: 0 });
      }
    }
    for (const c of byId.values()) {
      c.finalScore = vecWeight * c.vecScore + (1 - vecWeight) * (c.kwScore ?? 0);
    }
    return [...byId.values()];
  }
}
```

**注意**（实现时核对，非测试断言）：`multi=false` 分支下 `fuse()` 只收到 `vecRows`，`kwScore` 始终 `undefined`，`finalScore = vecScore`——与测试用例「multi=false 时 finalScore = vecScore」一致。`kwScore=undefined` 在 `finalScore` 计算里用 `?? 0`，但因为 `kwRows` 为空数组，不会进入循环，`c.kwScore` 保持 `undefined`（不会被误写成 `0`），最终返回给调用方的 `kwScore` 字段是 `undefined`，满足契约 `.optional()` 语义。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @codecrush/backend test pg-hybrid-retriever`
Expected: PASS,11 个用例全绿

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/modules/retrieval/retriever.constants.ts apps/backend/src/modules/retrieval/ports/retriever.port.ts apps/backend/src/modules/retrieval/adapters/pg-hybrid-retriever.adapter.ts apps/backend/test/pg-hybrid-retriever.adapter.spec.ts
git commit -m "feat(retrieval): PgHybridRetriever——向量+关键词召回、加权融合、可选 rerank、三种降级路径"
```

---

### Task 9: `RetrievalService` + `RetrievalModule` 接线

**Files:**
- Modify: `apps/backend/src/modules/retrieval/retrieval.service.ts`
- Modify: `apps/backend/src/modules/retrieval/retrieval.controller.ts`
- Modify: `apps/backend/src/modules/retrieval/retrieval.module.ts`
- Test: `apps/backend/test/retrieval.service.spec.ts`

- [ ] **Step 1: 写失败测试**

```ts
// apps/backend/test/retrieval.service.spec.ts
import { RetrievalService } from "../src/modules/retrieval/retrieval.service";
import type { RetrieverPort } from "../src/modules/retrieval/ports/retriever.port";

describe("RetrievalService.test", () => {
  it("调用注入的 RetrieverPort.retrieve，把结果包进 {hits}", async () => {
    const hit = {
      chunkId: "c1",
      docId: "d1",
      docName: "d.pdf",
      text: "t",
      section: "s",
      vecScore: 0.9,
      finalScore: 0.9,
    };
    const port: RetrieverPort = { retrieve: jest.fn(async () => [hit]) };
    const svc = new RetrievalService(port);
    const req = {
      query: "q",
      kbId: "kb1",
      embedModelId: "m2",
      topK: 10,
      threshold: 0.2,
      multi: true,
    };
    const res = await svc.test(req);
    expect(port.retrieve).toHaveBeenCalledWith(req);
    expect(res).toEqual({ hits: [hit] });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @codecrush/backend test retrieval.service`
Expected: FAIL,现有 `RetrievalService` 构造函数不接受参数，`test()` 返回硬编码值

- [ ] **Step 3: 实现**

```ts
// apps/backend/src/modules/retrieval/retrieval.service.ts
import { Inject, Injectable } from "@nestjs/common";
import type { RetrievalTestRequest, RetrievalTestResponse } from "@codecrush/contracts";
import { RETRIEVER_PORT } from "./retriever.constants";
import type { RetrieverPort } from "./ports/retriever.port";

@Injectable()
export class RetrievalService {
  constructor(@Inject(RETRIEVER_PORT) private readonly retriever: RetrieverPort) {}

  async test(req: RetrievalTestRequest): Promise<RetrievalTestResponse> {
    const hits = await this.retriever.retrieve(req);
    return { hits };
  }
}
```

```ts
// apps/backend/src/modules/retrieval/retrieval.controller.ts
import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { createZodDto } from "nestjs-zod";
import { RetrievalTestRequestSchema, type RetrievalTestResponse } from "@codecrush/contracts";
import { RetrievalService } from "./retrieval.service";

class RetrievalTestRequestDto extends createZodDto(RetrievalTestRequestSchema) {}

@Controller("retrieval")
export class RetrievalController {
  constructor(private readonly retrievalService: RetrievalService) {}

  @Post("test")
  @HttpCode(200)
  test(@Body() body: RetrievalTestRequestDto): Promise<RetrievalTestResponse> {
    return this.retrievalService.test(body);
  }
}
```

```ts
// apps/backend/src/modules/retrieval/retrieval.module.ts
import { Module } from "@nestjs/common";
import { RetrievalController } from "./retrieval.controller";
import { RetrievalService } from "./retrieval.service";
import { RETRIEVER_PORT } from "./retriever.constants";
import { PgHybridRetriever } from "./adapters/pg-hybrid-retriever.adapter";
import { ChunksModule } from "../chunks/chunks.module";
import { ModelsModule } from "../models/models.module";
import { KnowledgeBasesModule } from "../knowledge-bases/knowledge-bases.module";

// 无环风险：没有任何模块 import RetrievalModule（008 §模块边界，diff-report.md 已核实），
// 可以直接三个 imports，不需要 KnowledgeBasesModule 那种"直接 provide 绕开 import"的手法。
@Module({
  imports: [ChunksModule, ModelsModule, KnowledgeBasesModule],
  controllers: [RetrievalController],
  providers: [RetrievalService, { provide: RETRIEVER_PORT, useClass: PgHybridRetriever }],
})
export class RetrievalModule {}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @codecrush/backend test retrieval.service`
Expected: PASS

- [ ] **Step 5: 类型检查全量**

Run: `pnpm --filter @codecrush/backend build`
Expected: 通过,无 TS 报错(尤其确认 `retrieval.controller.ts` 的 `test()` 返回 `Promise<RetrievalTestResponse>` 后 NestJS 装饰器/`nestjs-zod` 集成不报类型错)

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/modules/retrieval/retrieval.service.ts apps/backend/src/modules/retrieval/retrieval.controller.ts apps/backend/src/modules/retrieval/retrieval.module.ts apps/backend/test/retrieval.service.spec.ts
git commit -m "feat(retrieval): RetrievalService/Module 接真实 RetrieverPort，去掉硬编码桩"
```

---

### Task 10: `skeleton.e2e.spec.ts` 扩展 — 既有测试维护

**Files:**
- Modify: `apps/backend/test/skeleton.e2e.spec.ts`

- [ ] **Step 1: 扩展 `inMemoryChunksRepo`**

`apps/backend/test/skeleton.e2e.spec.ts:330-337`，在现有 `deleteByVersion: async () => 0,` 之后加:

```ts
  searchByVector: async () => [],
  searchByKeyword: async () => [],
```

- [ ] **Step 2: 扩展 `fakeModelProviderPort`**

`apps/backend/test/skeleton.e2e.spec.ts:223-229`，在现有 `embed` 之后加:

```ts
  rerank: jest.fn(async (_config: unknown, _query: string, documents: string[]) => ({
    results: documents.map((_, i) => ({ index: i, score: 0.5 })),
  })),
```

- [ ] **Step 3: 跑既有 2 个 retrieval 用例确认仍过**

Run: `pnpm --filter @codecrush/backend test skeleton.e2e -t retrieval`
Expected: PASS(`POST /api/retrieval/test → 200 + schema` 与 `非法 body → 400` 两个既有用例，`kbId:"kb1"`/`embedModelId:"m2"` 复用文件里更早创建的第一个 KB/第二个模型,见 spec.md 调查发现)

- [ ] **Step 4: 加一条新用例覆盖 rerank 分支的端到端接线**

`skeleton.e2e.spec.ts:422` 的 `let modelId: string` 是块作用域在 `describe("models", ...)` 内部的局部变量，`describe("retrieval", ...)` 看不到它；而且该 describe 块最后一个用例(`DELETE → 204，再 GET → 404`)已经把这个模型行删掉了，即便作用域可见也指向一个已删除的行。改用文件级作用域的 `embeddingModelId`(`skeleton.e2e.spec.ts:547` 声明，`ensureEmbeddingModel()` 幂等创建，供 KB/documents/chunks 几个 describe 块共用)——它的模型行始终存在于 `inMemoryModelsRepo`。

在 `describe("retrieval", ...)` 块内(`skeleton.e2e.spec.ts:854-877`)最后一个 `it` 之后加:

```ts
it("POST /api/retrieval/test 带 rerankModelId → fake rerank port 被调用", async () => {
  await ensureEmbeddingModel();
  const res = await request(app.getHttpServer())
    .post("/api/retrieval/test")
    .set(auth())
    .send({
      query: "退货",
      kbId: "kb1",
      embedModelId: embeddingModelId,
      topK: 10,
      threshold: 0,
      multi: false,
      // 复用同一个 embedding 类型模型 id 当 rerankModelId：fakeModelProviderPort.rerank 不校验
      // config.type，这里只验证接线（HTTP → service → port.rerank 被调到）而非真实业务校验，
      // 不需要专门再建一个 type:"rerank" 的模型行。
      rerankModelId: embeddingModelId,
    })
    .expect(200);
  expect(() => RetrievalTestResponseSchema.parse(res.body)).not.toThrow();
});
```

- [ ] **Step 5: 跑全部 e2e 测试确认通过**

Run: `pnpm --filter @codecrush/backend test skeleton.e2e`
Expected: PASS,全部用例(含新增的 rerank 用例)通过

- [ ] **Step 6: Commit**

```bash
git add apps/backend/test/skeleton.e2e.spec.ts
git commit -m "test(retrieval): 扩展 e2e 内存假实现覆盖 searchByVector/searchByKeyword/rerank"
```

---

### Task 11: 前端 `RetrievalTestPage.tsx` — antd 重写 + 接真实 API

**Files:**
- Modify: `apps/frontend/src/pages/admin/RetrievalTestPage.tsx`
- Delete: `apps/frontend/src/mocks/retrieval.ts`(确认 Step 1 无其它消费方后删除)

前端页面无自动化测试覆盖(项目现有惯例——`apps/frontend` 未见 `.test.tsx`/`.spec.tsx` 覆盖任何一个 admin 页面),本任务靠 Step 4 的手动 `/ship:qa` 验证,不新增前端测试基础设施(与 Task 5/6 的测试策略决定同源)。

- [ ] **Step 1: 确认 `mocks/retrieval.ts` 无其它消费方**

Run: `grep -rln "mocks/retrieval" apps/frontend/src`
Expected: 只有 `RetrievalTestPage.tsx` 自己(spec.md 调查阶段已确认一次，重写前再核实一遍防止期间有新增消费方)。

- [ ] **Step 2: 重写页面**

```tsx
// apps/frontend/src/pages/admin/RetrievalTestPage.tsx
import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  InputNumber,
  Select,
  Slider,
  Switch,
  Tag,
} from "antd";
import type { KnowledgeBase, ModelProvider, RetrievalHit } from "@codecrush/contracts";
import { getKnowledgeBases, getModels, testRetrieval } from "../../api/client";

const { TextArea } = Input;

/** 知识检索测试：左配置 + 右结果。M5 接真实 POST /api/retrieval/test，antd 组件化重写。 */

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function RetrievalTestPage() {
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [models, setModels] = useState<ModelProvider[]>([]);
  const [loadErr, setLoadErr] = useState("");

  const [kbId, setKbId] = useState<string>();
  const [embedModelId, setEmbedModelId] = useState<string>();
  const [threshold, setThreshold] = useState(0.65);
  const [vecWeight, setVecWeight] = useState(0.6);
  const [rerankModelId, setRerankModelId] = useState<string>();
  const [rerankThreshold, setRerankThreshold] = useState(0.5);
  const [multi, setMulti] = useState(true);
  const [topK, setTopK] = useState(20);
  const [topN, setTopN] = useState(10);
  const [query, setQuery] = useState("");

  const [running, setRunning] = useState(false);
  const [ran, setRan] = useState(false);
  const [runErr, setRunErr] = useState("");
  const [hits, setHits] = useState<RetrievalHit[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const [kbList, modelList] = await Promise.all([getKnowledgeBases(), getModels()]);
        setKbs(kbList);
        setModels(modelList);
        if (kbList[0]) setKbId(kbList[0].id);
        const firstEmbed = modelList.find((m) => m.type === "embedding" && m.enabled);
        if (firstEmbed) setEmbedModelId(firstEmbed.id);
      } catch (e) {
        setLoadErr(errMsg(e));
      }
    })();
  }, []);

  const embedOpts = models.filter((m) => m.type === "embedding" && m.enabled);
  const rerankOpts = models.filter((m) => m.type === "rerank" && m.enabled);

  const run = async () => {
    if (!query.trim() || !kbId || !embedModelId) return;
    setRunning(true);
    setRunErr("");
    try {
      const res = await testRetrieval({
        query: query.trim(),
        kbId,
        embedModelId,
        topK,
        threshold,
        multi,
        vecWeight,
        rerankModelId,
        rerankThreshold: rerankModelId ? rerankThreshold : undefined,
        topN,
      });
      setHits(res.hits);
      setRan(true);
    } catch (e) {
      setRunErr(errMsg(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>知识检索测试</div>
      <div style={{ fontSize: 13, color: "rgba(0,0,0,.45)", marginBottom: 16, lineHeight: 1.7 }}>
        验证召回配置：确认当前设置能从知识库召回正确的文本块。此处的调整仅用于测试，不会自动保存到 Agent 配置。
      </div>
      {loadErr && <Alert type="error" message={loadErr} style={{ marginBottom: 16 }} />}

      <div style={{ display: "grid", gridTemplateColumns: "420px 1fr", gap: 16, alignItems: "start" }}>
        <Card title="测试设置" size="small">
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <Field label="检索知识库">
              <Select
                value={kbId}
                onChange={setKbId}
                options={kbs.map((k) => ({ value: k.id, label: k.name }))}
                style={{ width: "100%" }}
              />
            </Field>
            <Field label="向量模型（Embedding）">
              <Select
                value={embedModelId}
                onChange={setEmbedModelId}
                options={embedOpts.map((m) => ({ value: m.id, label: m.name }))}
                style={{ width: "100%" }}
              />
            </Field>
            <Field label={`相似度阈值 · ${threshold.toFixed(2)}`}>
              <Slider min={0} max={1} step={0.01} value={threshold} onChange={setThreshold} />
            </Field>
            <Field
              label={`向量 / 关键词权重 · 向量 ${vecWeight.toFixed(2)} · 关键词 ${(1 - vecWeight).toFixed(2)}`}
            >
              <Slider min={0} max={1} step={0.05} value={vecWeight} onChange={setVecWeight} />
            </Field>
            <Field label="Rerank 模型">
              <Select
                value={rerankModelId}
                onChange={setRerankModelId}
                allowClear
                placeholder="不启用重排"
                options={rerankOpts.map((m) => ({ value: m.id, label: m.name }))}
                style={{ width: "100%" }}
              />
            </Field>
            {rerankModelId && (
              <Field label={`Rerank 分数阈值 · ${rerankThreshold.toFixed(2)}`}>
                <Slider min={0} max={1} step={0.01} value={rerankThreshold} onChange={setRerankThreshold} />
              </Field>
            )}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 13, color: "rgba(0,0,0,.65)" }}>多路召回（向量 + 关键词）</div>
                <div style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>关闭则仅向量召回</div>
              </div>
              <Switch checked={multi} onChange={setMulti} />
            </div>
            <Field label="召回 Top-K">
              <InputNumber min={1} max={200} value={topK} onChange={(v) => setTopK(v ?? 20)} style={{ width: "100%" }} />
            </Field>
            <Field label="前 N 条">
              <Select
                value={topN}
                onChange={setTopN}
                options={[5, 10, 20, 50].map((n) => ({ value: n, label: `前 ${n} 条` }))}
                style={{ width: "100%" }}
              />
            </Field>
            <Field label="测试问题">
              <TextArea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="输入一个问题，测试能召回哪些文本块…"
                rows={4}
              />
            </Field>
            <Button
              type="primary"
              onClick={run}
              loading={running}
              disabled={!query.trim() || !kbId || !embedModelId}
              style={{ alignSelf: "flex-end" }}
            >
              运行 ➤
            </Button>
          </div>
        </Card>

        <Card
          title={
            <span>
              测试结果
              {ran && (
                <span style={{ fontSize: 13, fontWeight: 400, color: "rgba(0,0,0,.45)", marginLeft: 10 }}>
                  共 {hits.length} 条 · 阈值 {threshold.toFixed(2)} 以上
                </span>
              )}
            </span>
          }
          size="small"
        >
          {runErr && <Alert type="error" message={runErr} style={{ marginBottom: 12 }} />}
          {ran ? (
            hits.length === 0 ? (
              <Empty description="没有召回结果，尝试降低相似度阈值" />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {hits.map((r, i) => (
                  <div key={r.chunkId} style={{ border: "1px solid #f0f0f0", borderRadius: 8, overflow: "hidden" }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 16,
                        padding: "9px 14px",
                        background: "#fafafa",
                        borderBottom: "1px solid #f0f0f0",
                      }}
                    >
                      <Tag color="blue">#{i + 1}</Tag>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "#1677ff" }}>
                        {(r.finalScore * 100).toFixed(2)} <span style={{ fontWeight: 400, color: "rgba(0,0,0,.4)" }}>最终</span>
                      </span>
                      {r.vecScore !== undefined && (
                        <span style={{ fontSize: 12, color: "rgba(0,0,0,.5)" }}>{(r.vecScore * 100).toFixed(2)} 向量</span>
                      )}
                      {r.kwScore !== undefined && (
                        <span style={{ fontSize: 12, color: "rgba(0,0,0,.5)" }}>{(r.kwScore * 100).toFixed(2)} 关键词</span>
                      )}
                      {r.rerankScore !== undefined && <Tag color="purple">已重排</Tag>}
                      <div style={{ flex: 1 }} />
                      <span style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>{r.docName}</span>
                    </div>
                    <div style={{ padding: "12px 14px", fontSize: 13, lineHeight: 1.85, whiteSpace: "pre-wrap" }}>
                      {r.text}
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : (
            <Empty description="输入问题并点击「运行」查看召回结果" />
          )}
        </Card>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 13, color: "rgba(0,0,0,.65)" }}>{label}</div>
      {children}
    </div>
  );
}
```

- [ ] **Step 3: 删除不再使用的 mock 文件**

```bash
rm apps/frontend/src/mocks/retrieval.ts
```

- [ ] **Step 4: 类型检查 + lint**

Run: `pnpm --filter @codecrush/frontend build`
Expected: 通过,无 TS 报错

Run: `pnpm lint`
Expected: 0 边界违规

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/pages/admin/RetrievalTestPage.tsx
git rm apps/frontend/src/mocks/retrieval.ts
git commit -m "feat(frontend): 检索测试台改用 antd 组件 + 真实 POST /api/retrieval/test"
```

---

### Task 12: 端到端手动验证(`/ship:qa`)

**Files:** 无代码改动,纯验证。

- [ ] **Step 1: 起本地环境**

```bash
docker compose -f infra/docker-compose.yml --profile infra up -d --wait
pnpm --filter @codecrush/backend db:migrate
pnpm dev
```

- [ ] **Step 2: 登录后台,在「模型调用管理」注册至少一个 embedding 模型、一个 rerank 模型(或用已有测试数据)**

- [ ] **Step 3: 上传文档到某个知识库,等待入库完成(切片可见)**

- [ ] **Step 4: 打开「检索测试」,验证:**
  - 输入知识库中确实存在相关内容的问题,点「运行」,能看到真实召回结果(不是硬编码那条 mock)
  - 关闭「多路召回」,结果只展示向量分,不展示关键词分
  - 开启多路召回,同一条结果同时展示向量分、关键词分、最终分,`最终 ≈ 向量*权重 + 关键词*(1-权重)`
  - 选择一个 rerank 模型,结果出现「已重排」标签,最终分变为 rerank 模型给出的分数
  - 调整相似度阈值滑杆,结果数量随之增减
  - 调低阈值到 0,输入知识库里完全不相关的问题,验证不会出现"没有召回结果"时的报错,而是空态提示

- [ ] **Step 5: 记录验证结果**

若发现问题,回到对应 Task 修正;若全部通过,本任务(M5 检索)实现完成。

---

## Self-review(对照 spec.md acceptance criteria)

1. 检索测试台真实召回 + 三种分数展示 → Task 11 + Task 12 覆盖
2. `POST /api/retrieval/test` 200/400 → Task 9(controller)+ Task 10(e2e 用例)覆盖
3. `pnpm --filter @codecrush/backend test` 全绿 → Task 1-10 每个 Step 都跑测试确认
4. `pnpm lint` 零边界违规 → Task 11 Step 4 显式检查
5. `chunks.tsv` 迁移可跑通 → Task 5 覆盖

Placeholder 扫描:全文无 "TBD"/"TODO"/"类似 Task N"。Task 3/Task 4 的测试用例因为要对齐现有文件已有的 mock 手法(而非发明新写法),用了"实现时对齐该文件已有的 XX 写法"这类措辞——这不是占位符,是明确指向"复制现有同文件里 embedTexts/embed 用例的 setup 代码结构"这一具体、可执行的指令,不是留白。
