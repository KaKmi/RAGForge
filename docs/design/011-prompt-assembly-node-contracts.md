---
title: "Prompt 组装与 LLM 节点契约（NodeContract 执行引擎）"
description: "四个固定节点的完整 NodeContract 数据、两层 Prompt 组装与 NodeRuntimeService 执行/校验/Fallback 设计，本轮写死代码。"
category: "design"
number: "011"
status: draft
services: [backend, contracts]
related: ["design/001", "design/002", "design/003", "design/009", "design/012"]
last_modified: "2026-07-11"
---

# 011 — Prompt 组装与 LLM 节点契约（NodeContract 执行引擎）

## Status

`draft` — 经 `/ship:arch-design` 完成。本文是 [012-prompt-management-redesign](012-prompt-management-redesign.md)（写作时为 009，后因编号被 M7 应用管理占用而改为 012）明确标记的已知缺口的补齐文档，同时恢复 `001`/`002`/`003` 中此前对"011"的悬空引用（原 011 文档已被用户删除，不再作为权威来源）。M7 的产品语义已由 [009-m7-application-management](009-m7-application-management.md) 从"Agent 管理"改为"应用管理"。2026-07-11 应用聚焦原型进一步确认应用使用单一 production 指针，发布门禁需要真实 NodeRuntime 样例预演；本文同步修订 `compileAndSample()` 输入契约。

`node-runtime` 模块目前不存在，`chat.service.ts` 是 M2 硬编码桩代码，`ModelProviderPort` 目前只有 `testConnection()`/`embed()`/`rerank()`，没有 `chat()` 方法。本文是从当前代码基线出发的全新设计，不是复原已删除的旧文档；四个节点的具体契约内容取自最新原型 `RAG知识库问答系统设计/CodeCrushBot.dc.html` 的 `NODE_CONTRACT` 对象（约第 3604–3633 行）与 `compile()` 编译规则（约第 3638–3667 行）。

## Summary

定义四个固定 LLM 节点（问题改写 `rewrite` / 意图识别 `intent` / 回复生成 `reply` / 兜底 `fallback`）v1 版本的完整 NodeContract 内容，把原型里已经写好的平台固定 System 外壳文案、输入/保留字段、输出 Schema、动态校验规则、Fallback 行为落地为代码定义的 `NodeContractRegistry`。设计两层 Prompt 组装（平台固定 System + 管理员 Instructions 拼接为一条 system 消息[复用 012 §5 的 `compilePromptBody`，新增严格渲染 `renderTemplateStrict`] + 平台运行时数据 JSON 作为 user 消息）与统一执行入口 `NodeRuntimeService`：`executeStructured()` 服务 rewrite/intent（等待完整响应 → Zod Schema 校验 → `extraValidate` 动态值域校验 → 失败修复一次 → 仍失败走确定性 Fallback），`streamText()` 服务 reply/fallback（流式转发 + 首 token 超时/断流边界处理，不做 JSON 修复重试）。

为此扩展 `ModelProviderPort`：新增 `chat()`/`chatStream()` 方法与中性 `structuredOutput` 参数，按 `(type=llm, protocol)` 适配 `openai_compat`/`anthropic`/`gemini` 三种协议各自的原生结构化输出机制；无论模型是否声称支持原生能力，后端 Zod 终审永远执行。

**本轮 NodeContract 的全部内容写死在代码里**（TS 常量 + 注册表，非 DB 表）。用户已确认未来会做一个独立的"应用配置"管理页面给平台管理员配置这套契约数据，但本轮明确不做该页面、不做 DB 化——本文只负责把接口设计得不排斥这条未来路径，并且明确划出一条边界（Design §7）：只有纯文案类内容（System 外壳文案、字段说明、Fallback 提示文案）适合未来下沉为可配置数据，Schema 结构定义、动态校验逻辑、Fallback 执行函数必须继续保持类型安全的代码形式。

## Boundaries

> 反漂移边界。任何实现若越过以下范围，应先回来改本文。

**In-scope**

- 四个节点 v1 NodeContract 的完整具体内容（System 外壳文案、`inputs`、`reserved`、`outSchema` 字段定义与示例、`extraValidate` 规则、`fallback` 行为），数据来源于原型 `NODE_CONTRACT` 对象。
- `NodeContractRegistry`：代码定义（非 DB 表），按 `(node, contractVersion)` 解析。
- `ModelProviderPort` 扩展：新增 `chat()`（非流式，供结构化节点用）与 `chatStream()`（流式，供文本节点用），新增中性 `structuredOutput` 参数；`openai_compat`/`anthropic`/`gemini` 三种协议的结构化输出适配映射；后端 Zod 终审永不因原生能力而跳过。
- 两层 Prompt 组装：平台固定 System + 管理员 Instructions 拼接为一条 system 消息（复用 012 §5 的 `compilePromptBody`，新增 `renderTemplateStrict` 严格渲染）+ 平台运行时数据 JSON envelope 作为 user 消息。
- `NodeRuntimeService.executeStructured()` / `streamText()` 两个独立入口及其内部归一化 → 校验 → 修复一次 → Fallback 全流程。
- 模块文件组织：`apps/backend/src/modules/node-runtime/{contracts,compiler,executor}/`，落实 003 已定义的模块边界。
- Prompt 预览端点从 012 §6 的 `mode:'unavailable'` 占位升级为真实 `mode:'structured'`/`mode:'text'`。
- 暴露给应用发布门禁调用的接口形状（`compileAndSample()`），只定义接口，不设计门禁本身的 UX/存储。
- Observability：`rag.node.*`/`rag.prompt.*`/`rag.validation.*`/`rag.repair.*`/`rag.fallback.*`/`rag.structured_output.mode` 等 span 属性。
- **"写死代码 vs 未来可配置"的边界**：明确哪些内容未来可以安全下沉到 DB+UI（纯文案），哪些必须继续留在代码（Schema 结构、校验逻辑、Fallback 函数）。

**Out-of-scope**

- 那个"应用配置"管理页面本身的实现——本轮不做，只在 Revisit triggers/Assumptions 给出迁移方向和边界原则。
- 应用发布门禁的 UI/存储/触发流程——属于 [009-m7-application-management](009-m7-application-management.md)，本文只定义 node-runtime 暴露给它调用的接口。
- 应用 production 指针、ReleaseCheck、队列与发布确认——同上，见 009-m7-application-management，本文不重复设计。
- 新增第 5 个节点类型、管理员自定义节点——明确不做。
- M11 语义级 Eval / LLM Judge——本文只做结构和值域校验，不做准确率评测。
- 管理员通过任何界面修改 Schema/System/Fallback——本轮不做；即使未来"应用配置"页面上线，也只开放文案类字段，不开放 Schema 结构本身（见 Invariant 6）。

**Invariants**

1. **非法结构化输出绝不进入编排下游**（承接 001 Invariant 6）：rewrite/intent 必须通过 `outputSchema` 和 `extraValidate`，否则修复或 Fallback；编排代码不得消费原始模型文本。
2. **PromptVersion 固定 ContractVersion**（承接 001 Invariant 7）：Contract 升级不改变已绑定旧版本的线上应用行为。
3. **预览等于运行时**：Prompt 预览 API、应用发布门禁、chat 运行时必须共用同一 `NodeRuntimeService` 路径，任何一方不得自行拼接 Prompt 或解析模型 JSON。
4. **后端 Zod 终审永远执行**：无论 `structuredOutput` 走原生 JSON Schema / Tool Calling / JSON Object 哪条路径，都不能因"模型声称支持"而跳过服务端复验。
5. **修复最多一次**：结构校验失败最多修复重试一次，不允许递归重试或无限增加延迟成本。
6. **文案与结构分离**：NodeContract 现在整体是代码定义；即便未来把 System 外壳文案、字段说明、Fallback 提示文案等纯文本部分下沉到可配置存储，Zod Schema 的结构定义、`extraValidate` 校验逻辑、Fallback 的实际执行函数必须继续保持类型安全的代码形式，不能变成允许任意运行时字符串求值/无约束 JSON 编辑的"什么都能改"配置项——这是安全边界，不是实现顺序问题。

## Context

延续 009 的现状描述：`node-runtime` 目录不存在，`chat.service.ts` 是 M2 桩代码。补充新发现：`apps/backend/src/modules/models/ports/model-provider.port.ts` 当前只定义了 `testConnection()`/`embed()`/`rerank()` 三个方法，源码注释写着"终态为 001 `chat()/embed()/rerank()`，M3 只需连通性测试；M4/M8 按需加必选方法（非破坏扩展）"——`chat()` 从一开始就是留白等 M8 补的方法，本文是第一个需要它的消费方，需要在本文里把它的形状定下来。

009 已经定义了"静态字段契约"（四节点固定 input/reserved 字段名表 + `compilePromptBody()` 编译规则），本文复用它、不重新定义，只在其基础上补上真正需要模型调用的执行部分。001 已经定义模型协议只有三种（llm: `openai_compat`/`anthropic`/`gemini`），本文的结构化输出适配就在这三种协议范围内设计，不引入新协议。

## Goals / Non-goals

**Goals**

- 把四个节点从"管理员写什么就是完整 Prompt"变成"管理员只写策略，平台保证接口、结构、失败降级"。
- 让 Prompt 预览、应用发布预演、C 端运行三处共用同一套组装/校验代码，不出现"预览过了但线上跑不过"的落差。
- `ModelProviderPort` 补齐 `chat()`，且新增的结构化能力不绑定任何具体厂商实现。

**Non-goals**

- 不追求"模型返回的 JSON 语义一定正确"——结构和值域由本文保证，语义质量留给未来 M11 Eval。
- 不做管理员可编辑 Schema。
- 不做本轮的可配置化页面（见 Boundaries Out-of-scope）。

## Requirements & 关键数字

延续 001 的整体规模假设（≤10 QPS）。

| 维度                     |                                                     设计值 | 依据/影响                                                      |
| ------------------------ | ---------------------------------------------------------: | -------------------------------------------------------------- |
| 结构化节点修复预算       |                                    每节点最多 1 次修复重试 | 最坏增加 1 次额外 LLM 调用；正常问答不增加调用                 |
| 本地编译/Schema 校验预算 |                                             p95 < 5ms/节点 | 不涉及网络调用，相对模型延迟可忽略                             |
| Prompt 正文上限          |                                      沿用 009 已有编辑约束 | 防止无界配置                                                   |
| 单节点原始模型输出上限   |                                                       64KB | 超限直接判定失败，避免下游 JSON parser/日志压力                |
| 应用发布预演样例数       | rewrite/intent 各 10 例 + reply/fallback 各 1 冒烟 = 22 次 | 低频操作可接受；具体触发时机属于 009-m7-application-management |
| 线上目标                 |      非法结构化输出下游泄漏 0；修复率 <1%；Fallback 率 <1% | 连续 100 次同节点调用中修复率或 Fallback 率 >3% 告警           |

## Design

### 1. 四个 v1 NodeContract 的完整内容

#### 问题改写 `rewrite`

| 属性                 | 值                                                     |
| -------------------- | ------------------------------------------------------ |
| key / consumer       | `rewrite` / 编排代码 · 拿去检索                        |
| weight / runtimeMode | 重契约 / `structured`（`structuredMode: json_schema`） |
| contractVersion      | 1                                                      |

平台固定 System：

> 你是 RAG 流程中的「问题改写」节点。将当前问题改写成可独立理解、适合知识库检索的问题。不要回答问题，不要添加输入中不存在的事实。输出必须符合平台提供的 JSON Schema。

| 分类          | 字段             | 说明                                                                     |
| ------------- | ---------------- | ------------------------------------------------------------------------ |
| inputs        | `query`          | 当前问题，不可空                                                         |
| inputs        | `history`        | 历史对话，可空                                                           |
| reserved      | —                | 无                                                                       |
| outSchema     | `rewrittenQuery` | `string`·非空·≤1000，示例 `"Python 入门课程 7 天内未学习是否可全额退款"` |
| outSchema     | `keywords`       | `string[]`·≤20，示例 `["退款","七天无理由","学习进度"]`                  |
| extraValidate | —                | 无                                                                       |
| fallback      | —                | 直接用原始 `query` 去检索，`keywords` 置空                               |

#### 意图识别 `intent`

| 属性                 | 值                                                                  |
| -------------------- | ------------------------------------------------------------------- |
| key / consumer       | `intent` / 编排代码 · 拿去路由                                      |
| weight / runtimeMode | 重契约 / `structured`（`structuredMode: json_schema`，`dyn: true`） |
| contractVersion      | 1                                                                   |

平台固定 System：

> 你是 RAG 流程中的「意图识别」节点。从平台在运行时注入的候选路由中，选出与用户问题最匹配的意图与路由，并给出置信度。只做判断，不回答问题。输出必须符合平台提供的 JSON Schema。

| 分类          | 字段              | 说明                                                                                                                 |
| ------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| inputs        | `query`           | 不可空                                                                                                               |
| inputs        | `history`         | 可空                                                                                                                 |
| reserved      | `availableRoutes` | 候选路由，由应用绑定的知识库运行时派生，只读注入                                                                     |
| outSchema     | `intent`          | `enum`：售前/售后/学习/unknown                                                                                       |
| outSchema     | `routeIds`        | `string[]`·须 ∈ `availableRoutes`，示例 `["kb_aftersales"]`                                                          |
| outSchema     | `confidence`      | `number`·0–1，示例 `0.92`                                                                                            |
| extraValidate | —                 | `routeIds` 的每个值必须属于本次 `availableRoutes`；模型即使返回合法 JSON，也不能路由到应用未绑定的知识库，越权即拒绝 |
| fallback      | —                 | `intent=unknown`、`routeIds` 置空，走默认库或直接进兜底                                                              |

#### 回复生成 `reply`

| 属性                 | 值                       |
| -------------------- | ------------------------ |
| key / consumer       | `reply` / 终端用户直接看 |
| weight / runtimeMode | 轻契约 / `stream`        |
| contractVersion      | 1                        |

平台固定 System：

> 你是 RAG 流程中的「回复生成」节点。只依据平台提供的检索内容回答，不得编造；引用某段知识时在句末标注对应角标 [n]。以自然语言流式回答，不要输出 JSON。

| 分类          | 字段               | 说明                                                                                               |
| ------------- | ------------------ | -------------------------------------------------------------------------------------------------- |
| inputs        | `query`            | 不可空                                                                                             |
| inputs        | `history`          | 可空                                                                                               |
| inputs        | `retrievalContext` | 可空                                                                                               |
| reserved      | `citations`        | 引用来源，平台注入，用于角标 [n] 与出处                                                            |
| outSchema     | `text`             | `string`·非空·流式，示例 `"您购买的 Python 入门课程在 7 天内且学习进度为 0 时可申请全额退款 [1]…"` |
| extraValidate | —                  | 无                                                                                                 |
| fallback      | —                  | 平台固定兜底文案/触发转人工，不做 JSON 修复重试                                                    |

#### 兜底 `fallback`

| 属性                 | 值                                |
| -------------------- | --------------------------------- |
| key / consumer       | `fallback` / 终端用户直接看       |
| weight / runtimeMode | 轻契约 / `stream`（`last: true`） |
| contractVersion      | 1                                 |

平台固定 System：

> 你是 RAG 流程中的「兜底」节点。当问题超出知识库范围或上游失败时，礼貌说明暂时无法回答，并引导用户后续动作。

| 分类          | 字段    | 说明                                                                                          |
| ------------- | ------- | --------------------------------------------------------------------------------------------- |
| inputs        | `query` | 不可空                                                                                        |
| inputs        | —       | 无；PromptVersion 正文即最终返回的纯文本                                                      |
| reserved      | —       | 无                                                                                            |
| outSchema     | `text`  | `string`·非空，示例 `"很抱歉，这个问题暂时没有在知识库中找到答案，您可以联系人工客服…"`       |
| extraValidate | —       | 无                                                                                            |
| fallback      | —       | 正常路径直接返回管理员保存的 PromptVersion 正文；仅正文为空时使用代码内保底文案，均不调用模型 |

#### TypeScript 接口形状

```ts
interface NodeContract<TInput, TOutput, TReserved = Record<string, never>> {
  node: PromptNode; // rewrite | intent | reply | fallback
  version: number; // contractVersion
  key: string;
  consumer: string;
  weight: "重契约" | "轻契约";
  runtimeMode: "structured" | "stream";
  structuredMode?: "json_schema";

  inputSchema: z.ZodType<TInput>;
  reservedDataSchema: z.ZodType<TReserved>;
  outputSchema: z.ZodType<TOutput>;

  templateFields: Array<{
    name: string;
    label: string;
    description: string;
    requiredAtRuntime: boolean;
  }>; // 复用 012 §5 的静态字段契约

  systemInstructions: string; // 平台固定 System 外壳文案 —— 未来可配置化候选（见 §7）
  extraValidate?: (output: TOutput, context: RuntimeContext) => ValidationIssue[];
  fallback: (input: TInput, context: RuntimeContext) => TOutput;
}
```

`templateFields` 与 009 静态字段契约共享同一份字段名定义——本文的 `NodeContract` 是那套静态契约的超集，额外携带真正执行需要的 `outputSchema`/`systemInstructions`/`extraValidate`/`fallback`。实现时应把 009 的静态包作为本文 `NodeContractRegistry` 的输入而不是并列重复定义,否则两份字段名列表会漂移。

### 2. `ModelProviderPort` 扩展

当前接口只有 `testConnection`/`embed`/`rerank`。新增：

```ts
interface ChatMessage {
  role: "system" | "user";
  content: string;
}

interface StructuredOutputSpec {
  name: string;
  schema: Record<string, unknown>; // JSON Schema，从 Zod 转换
  strict?: boolean;
}

interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  structuredOutput?: StructuredOutputSpec;
}

interface ChatResult {
  content: string;
  raw?: unknown;
  usage?: { inputTokens: number; outputTokens: number };
}

interface ChatStreamChunk {
  delta?: string;
  done?: boolean;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
}

interface ModelProviderPort {
  testConnection(config: ModelCallConfig): Promise<TestModelResult>;
  embed(config: ModelCallConfig, texts: string[]): Promise<EmbedResult>;
  rerank(
    config: ModelCallConfig,
    query: string,
    documents: string[],
    topN?: number,
  ): Promise<RerankResult>;

  // 新增
  chat(
    config: ModelCallConfig,
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<ChatResult>;
  chatStream(
    config: ModelCallConfig,
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncIterable<ChatStreamChunk>;
}
```

这是对现有端口的非破坏性扩展（003 已预留"M4/M8 按需加必选方法，非破坏扩展"），不改动已有三个方法。`structuredOutput` 是中性参数,不绑定任何厂商语法,具体请求体构造下沉到 `models/adapters/protocols/*.ts` 的纯函数 builder（沿用 001/003 已确立的"单一 DI 适配器 + 按 `(type,protocol)` 查表分发"模式，不新增第二个 DI 适配器）。

结构化输出的协议适配表（llm 类型下 001 已定义的三种协议）：

| 协议              | 首选机制                                                                                                                   | 说明                                                                                                                                     | 后端终审                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `openai_compat`   | JSON Schema（`response_format: {type:"json_schema", json_schema, strict:true}`），不支持严格模式的厂商降级为 `json_object` | 覆盖 DeepSeek/Qwen/GPT/vLLM 等，实际支持程度因厂商而异，由模型注册时的连通性测试或 `model_providers.params` 里的能力标记决定走哪条子路径 | 必须继续 Zod + extraValidate |
| `anthropic`       | Tool Calling（强制单一结果工具，`tool_choice: {type:"tool", name:...}`，读取 `input` 字段作为结构化结果）                  | Anthropic 无独立 JSON Schema response_format，标准做法是强制工具调用                                                                     | 必须继续 Zod + extraValidate |
| `gemini`          | 原生 `responseSchema` + `responseMimeType: "application/json"`                                                             | Gemini 原生支持 JSON Schema 约束输出                                                                                                     | 必须继续 Zod + extraValidate |
| 无法探测/未知能力 | 追加格式要求到 Instructions，容忍单层代码围栏后解析（prompt-only 兜底）                                                    | 保底路径，供不支持任何原生机制的模型使用                                                                                                 | 必须继续 Zod + extraValidate |

模型能力（走哪条首选机制）由协议默认值决定，可被 `model_providers.params` 里的显式标记覆盖；连接测试可以探测但不能当永久保证——任何路径都不能因为"模型声称支持"而跳过 Zod 终审（Invariant 4）。

### 3. 两层 Prompt 组装

复用 012 §5 的字段契约与编译规则，新增"严格渲染"步骤 `renderTemplateStrict`——区别于现有 `packages/contracts/src/prompt-template.ts` 里较宽松的 `renderTemplate`（其注释已写明"只适用于预览"）。本文的严格版本才是真正进入模型请求的路径：

```ts
{
  messages: [
    { role: "system", content: `${contract.systemInstructions}\n\n${renderedAdminInstructions}` },
    // 平台固定指令在前、管理员 Instructions 渲染结果在后，拼接顺序由服务端代码
    // 保证——管理员正文内容本身无法把自己挪到 systemInstructions 之前，也无法让
    // 自己被解释成平台指令，因为这是字符串模板决定的，不依赖模型对 role 的理解。
    { role: "user", content: JSON.stringify(runtimeEnvelope) }, // 平台运行时数据，先过 inputSchema 再 JSON.stringify
  ],
  structuredOutput: contract.runtimeMode === 'structured'
    ? { name: `${contract.key}_v${contract.version}`, schema: contract.outputSchema, strict: true }
    : undefined,
}
```

不再需要区分 `developer` 角色：唯一需要用消息角色隔离的边界是"用户输入（不可信运行时数据）不能和管理员/平台内容混在同一个自由文本字段"，单独一条 `user` 消息已经覆盖这个边界。管理员 Instructions 与平台固定指令都是服务端可信内容，靠拼接顺序而非协议层 role 保证优先级，三个协议（openai_compat/anthropic/gemini）都能直接映射这两层消息，不需要任何按协议差异化的折叠逻辑。

### 4. `NodeRuntimeService` 两个入口

**`executeStructured(node, contractVersion, promptBody, modelId, input, context)`**（rewrite/intent）：

```
解析 Contract
  → 校验 runtime input（inputSchema）
  → 严格渲染管理员模板（renderTemplateStrict）
  → 组装两层消息
  → 调用 chat() 带 structuredOutput
  → 归一化原始响应（剥离代码围栏等）
  → outputSchema 校验
  → extraValidate
  → 失败：生成修复请求（携带原 Schema + 精简错误信息，不重跑管理员模板逻辑，不接受模型修改 Schema）重试一次
  → 仍失败：执行 contract.fallback()
  → 返回 typed output
```

**`streamText(node, contractVersion, promptBody, modelId, input, context)`**（reply/fallback）：

`reply` 走组装与 `chatStream()`；缓冲到首个非空 token（或很短的首段）才向调用方转发，首 token 前失败切换到 `contract.fallback()`。`fallback` 不走组装、不调用模型、不消费运行时字段，直接返回 `promptBody`；正文为空时才使用代码内保底文案。已经转发 token 后若上游断流，不可撤回已展示内容，向上层发出 `error`/`done(partial=true)` 事件并记录 Trace。

### 5. Prompt 预览端点升级

012 §6 定义的 `POST /api/prompts/:id/versions/:version/try-run` 在本文之后从"M6 简化版"升级为真实实现：rewrite/intent 改为直接调用 `executeStructured()`，返回 `{mode:'structured', fields, validateSteps, fallbackUsed}`；reply/fallback 改为调用 `streamText()`（或其非流式变体，供试运行这种一次性场景使用）。响应的 tagged union 形状已在 012 设计好，本文只是把 `unavailable` 分支替换为真实实现，不改变端点契约本身。

### 6. 应用发布门禁的调用接口（仅接口，不设计门禁本身）

`NodeRuntimeService` 暴露以下节点级接口。applications 负责选择应用配置版本、样例和运行上下文；NodeRuntime 只负责按真实运行路径执行，不依赖 applications：

```ts
interface NodeSampleRequest {
  node: PromptNode;
  contractVersion: number;
  promptVersionId: string;
  promptBody: string;
  modelId: string;
  modelParams: { temperature: number; topP: number };
  samples: Array<{ input: unknown; runtimeContext: RuntimeContext }>;
}

interface NodeSampleResult {
  ok: boolean;
  results: Array<{
    sampleIndex: number;
    ok: boolean;
    fallbackUsed: boolean;
    issues: ValidationIssue[];
    traceId?: string;
  }>;
}

compileAndSample(request: NodeSampleRequest): Promise<NodeSampleResult>
```

供 [009-m7-application-management](009-m7-application-management.md) 的异步 ReleaseCheck 调用（rewrite/intent 各 10 例 + reply/fallback 各 1 冒烟）。应用侧负责静态门禁、fingerprint、队列、有效期、发布确认和 UI；本文只保证样例执行与真实 chat 共用 NodeRuntime。旧版缺少 modelId/modelParams/runtimeContext 的接口无法复现应用运行，已由本接口取代。

### 7. "写死代码 vs 未来可配置"的具体边界

| NodeContract 字段                                              | 未来是否适合下沉为可配置数据           | 理由                                                                                                                                                                      |
| -------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `systemInstructions`（平台固定 System 文案）                   | 适合                                   | 纯文本，改错了最坏是文案不准确，不影响类型安全                                                                                                                            |
| `templateFields[].label`/`description`（字段展示文案）         | 适合                                   | 同上，纯展示层                                                                                                                                                            |
| `fallback` 对应的固定兜底提示文案（如兜底节点"很抱歉…"这句话） | 适合                                   | 纯文本，可以做成 DB 里的一个字符串字段                                                                                                                                    |
| `inputSchema`/`outputSchema`（Zod 结构定义）                   | **不适合**（本轮及可预见未来都不适合） | 结构定义直接决定运行时类型安全和下游代码能否正确消费，UI 自由编辑等于允许运行时任意改变接口形状，需要一整套 Schema Builder DSL + 沙箱校验才可能安全做到，成本和收益不匹配 |
| `extraValidate` 逻辑（如 routeIds 越权校验）                   | **不适合**                             | 是业务逻辑代码，不是数据                                                                                                                                                  |
| `fallback` 函数本身（如何从 input 构造降级 output 的算法）     | **不适合**                             | 同上，是代码不是数据                                                                                                                                                      |
| `contractVersion` 升级判定规则                                 | **不适合**                             | 版本语义必须严格，不能由配置页面随意触发                                                                                                                                  |

结论：未来那个"应用配置"页面如果要做，边界应该卡在"文案/展示层可配置，Schema/校验/降级逻辑仍是代码"——这条边界写进 Invariant 6，防止未来实现时把它做成一个无边界的通用 JSON 编辑器。

## Failure modes

| 场景                                                                | 系统行为                                                                      |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 模型返回非法 JSON / Markdown 代码围栏包裹                           | 归一化失败 → 修复一次 → 仍失败 Fallback                                       |
| JSON 形状合法但 `routeId` 越权                                      | `extraValidate` 拒绝 → intent Fallback 为 `unknown`                           |
| 模型声称支持结构化输出但实际不遵守                                  | Zod 捕获 → 记录 capability mismatch 指标 → 当前请求降级、后续触发模型配置检查 |
| 模型输出超过 64KB / 被截断                                          | 直接判定失败 → 修复一次后 Fallback                                            |
| 固定 ContractVersion 缺失（理论上因固定引用不应发生，但防御性处理） | 服务 readiness 失败，不允许"用最新版本替代"                                   |
| C 端修复调用超时                                                    | 不继续重试，立即 Fallback                                                     |
| reply 首 token 前失败                                               | 不发送空/半成品，直接切固定 Fallback                                          |
| reply 已发送 token 后断流                                           | 不可撤回；发送 `partial=true` 终态并记录 Trace                                |
| Trace/Collector 不可用                                              | 丢观测，不改变节点结果（承接 001 Invariant 1）                                |

## Rollout & operations

1. 先建 `node-runtime` 模块骨架（`contracts/`/`compiler/`/`executor/`）与四个 v1 Contract 定义，用 mock `ModelProviderPort` 跑契约测试（不依赖真实模型调用即可验证 Schema/校验/Fallback 逻辑正确性）。
2. 扩展 `ModelProviderPort.chat()`/`chatStream()` 及各协议 adapter（`openai_compat`/`anthropic`/`gemini`），复用 003 已确立的"单一 DI 适配器 + 纯函数 builder 表"模式，不新增 DI token。
3. 接入 009 已定义的 Prompt 预览端点，替换其 `mode:'unavailable'` 占位为真实 `executeStructured()`/`streamText()` 调用。
4. 暴露修订后的 `compileAndSample(NodeSampleRequest)`，供 [009-m7-application-management](009-m7-application-management.md) 的异步 ReleaseCheck 调用（本文只交付节点级执行接口，不交付队列、fingerprint 或 production 切换）。
5. M8 chat 编排接入：先接 rewrite/intent（`executeStructured()`），再接 reply/fallback（`streamText()`），逐步替换 `chat.service.ts` 当前的硬编码桩代码。
6. 全程无需数据库迁移（NodeContract 是代码常量，不落表）；`prompt_versions.contract_version` 字段已在 009 的迁移步骤里加好，本文只是让这个字段第一次有真正被消费的执行逻辑。

## Observability

沿用 001 已确立的 `gen_ai.*`/`rag.*` 属性体系，每个 LLM 节点 span 新增：

| 属性                          | 用途                                                        |
| ----------------------------- | ----------------------------------------------------------- |
| `rag.node.name`               | rewrite / intent / reply / fallback                         |
| `rag.prompt.version_id`       | 实际 PromptVersion                                          |
| `rag.prompt.contract_version` | 实际 ContractVersion                                        |
| `rag.validation.error_code`   | 输出或动态值域失败码，不记录完整敏感正文                    |
| `rag.repair.retry_count`      | 0 或 1                                                      |
| `rag.fallback.used`           | 是否执行 Fallback                                           |
| `rag.structured_output.mode`  | `json_schema` / `tool_call` / `json_object` / `prompt_only` |

告警初值：连续 100 次同节点调用中修复率或 Fallback 率 >3%，按 `model_id + prompt_version_id + contract_version` 聚合，区分模型能力问题/Prompt 策略问题/契约升级问题。试运行调用需要打区别于正式问答的标记（承接 009 Observability），避免污染正式指标。

## Security

- 管理员 Instructions 拼接在平台 System 指令之后、同一条 `system` 消息内，拼接顺序由服务端代码保证，管理员正文内容无法改变这个顺序；即使正文要求"忽略格式"也不能绕过 API 层 Structured Output 约束与后端 Schema 终审——这条防护本来就不依赖消息角色区分，只依赖 outputSchema/extraValidate/Fallback 在生成之后无条件执行。
- `availableRoutes`/`citations` 等保留数据由服务端生成，管理员不能在模板变量里伪造。
- C 端 `query`/`history` 作为已校验 JSON Runtime Data 发送，不与管理员模板手工字符串拼接，降低 Prompt Injection 改变消息边界的风险。
- 编译/预览请求限制正文、字段数、历史长度和输出大小，未知字段不从任意对象反射取值。
- 预览测试数据可能含 PII，日志/Trace 只记录版本、错误码、长度与脱敏摘要。
- 修复请求由平台生成，不回显密钥、System 全文或隐藏上下文给管理员/C 端。

## Alternatives considered

| 决策点             | 选择                                          | 拒绝                                   | 放弃了什么                                                               |
| ------------------ | --------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| 结构化输出保证方式 | API 原生 Structured Output + 后端 Schema 终审 | 只在管理员 Prompt 里写"返回 JSON"      | 更简单的实现——换来输出真正可信                                           |
| 运行时数据提供方式 | 始终注入，不依赖管理员写占位符                | 强制管理员必须写 `{query}`/`{history}` | 一点点上下文冗余——换来管理员漏写字段不失效                               |
| 执行能力归属       | 独立 `node-runtime` 域                        | `prompts`/`chat` 各自实现一套          | 更快的短期实现——换来预览等于生产、无重复逻辑                             |
| 失败策略           | 修复一次后确定性 Fallback                     | 无限重试 / 直接让整轮失败              | 部分请求质量降级——换来延迟和成本上界                                     |
| NodeContract 存储  | 代码常量（本轮）                              | 现在就做 DB + 可配置页                 | 短期的可配置灵活性——换来先把结构和安全边界想清楚，用户明确要求本轮先写死 |

## Assumptions

1. 四个节点类型首期固定；未来若需要新增节点或允许第三方自定义节点，NodeContract 的注册表机制与权限边界需要重新设计，不是本文当前形态的简单扩展。
2. PromptVersion body 保持不可变（012 已确立），`application_config_versions` 始终引用具体 PromptVersion（009 已确立）；这是 ContractVersion 固定语义成立的前提。
3. 模型适配层能够支持中性 structured output 请求；不支持任何原生能力的模型走 prompt-only 降级路径，准确率会更低但不阻断功能。
4. 用户确认的"应用配置"页面是未来独立评估的产品/技术决策，本文只负责让 NodeContract 的接口形状不排斥"文案类字段未来可下沉"这条路径，不代表该页面已经被批准实现。
5. 开发团队会保留仍被生产应用引用的旧 ContractVersion 实现，不做静默升级替换。

## Revisit triggers

- 用户决定启动"应用配置"页面时 → 重新做一轮独立 `/ship:arch-design`，范围严格按本文 Design §7 的"文案 vs 结构"边界表执行，不要顺手把 Schema/校验逻辑也做成可配置——如果确实需要，那是一个显著更大的决策（需要 Schema Builder DSL），应该单独论证。
- 节点类型超过 8 个或需要第三方自定义节点 → 从代码注册表升级为受签名/权限控制的声明式 Contract/插件体系。
- 线上 prompt-only 降级模式占比超过 20%，或同模型结构修复率连续 100 次 >3% → 收紧支持模型范围，或为该协议增加原生结构化适配。
- rewrite/intent 结构通过但语义错误率超过 5% → 提前实施 M11 Eval，扩大固定样例并阻断低分应用发布。
- 同一节点同时活跃 ContractVersion 超过 3 个 → 建迁移助手、兼容矩阵和旧版本退役流程。

## References

- 承接：`001-rag-platform-architecture`（Invariant 6/7，模型协议定义）、`002-implementation-roadmap`（M8.0 波次）、`003-code-organization`（`node-runtime` 模块边界、模型协议适配器组织）、[012-prompt-management-redesign](012-prompt-management-redesign.md)（静态字段契约、Prompt 预览端点的 `mode:'unavailable'` 占位）
- 配套：[009-m7-application-management](009-m7-application-management.md)（应用发布门禁的调用方，本文 §6 的接口消费者）
- 现状代码：`apps/backend/src/modules/models/ports/model-provider.port.ts`（当前无 `chat()`）、`apps/backend/src/modules/models/adapters/protocol-dispatch.adapter.ts`、`packages/contracts/src/prompt-template.ts`（现有较宽松的 `renderTemplate`，注释明确只适用于预览）
- 原型：`RAG知识库问答系统设计/CodeCrushBot.dc.html`（`NODE_CONTRACT` 对象约第 3604–3633 行，`compile()` 约第 3638–3667 行）
- 历史脉络（已删除，不作为权威来源）：旧 `011-prompt-assembly-node-contracts.md`、`docs/design/proposals/m8-node-contract-design.md`
