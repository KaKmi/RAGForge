# M3 Diff Report — Host vs Peer Spec

> Host: `spec.md` · Peer: `peer-spec.md`。仅记录分歧 + 裁决（一致项不记）。
> 证据基准：实际读过 `file:line`；架构权威 `docs/design/001-rag-platform-architecture.md`。
> Peer 为同 provider fallback subagent（无 Codex/Claude CLI），独立性弱于跨 provider peer，已记。

## 裁决汇总

| # | 分歧 | 裁决 |
|---|------|------|
| D1 | env 名 + key 编码 + 长度校验 | proven-false（peer `min(32)` 对 base64 错误）+ 名字偏好保留 host |
| D2 | e2e DB 策略（in-memory mock repo vs 真 PG） | proven-false（peer 引用的 traces.repository.spec.ts 实为 mock，非真 PG；无真 PG 先例；host 对齐代码库约定） |
| D3 | baseUrl required vs optional + 默认表 | conceded（peer 必填更简，去默认表死代码） |
| D4 | trace.llm/embeddings 封装 | 一致（均 non-goal，M8 revisit）—— 不记 |
| D5a | testConnection 用 GET /models vs POST 真路径 | conceded（peer POST 真路径验证 model name 可用） |
| D5b | port 暴露 chat/embed/rerank vs 仅 testConnection | proven-false（peer 扩 port 属 scope creep；testConnection 内部 POST 即可） |
| D6 | crypto 形态：纯函数 vs EncryptionService class + DI token + @Global SecurityModule | conceded（peer class + token 更可测 + 对齐 platform module 约定） |
| D8 | 列名 api_key_cipher vs api_key_enc | conceded（peer 对齐 `001:81` 架构权威） |
| D9 | maskApiKey 边界（长度 < 8） | patched（采纳 peer 边界处理） |
| D10 | deploymentId 列 | conceded（peer 对齐 `001:81`；host 漏列） |
| D11 | ModelProviderSchema（读 DTO）是否暴露 createdAt/updatedAt | host stands（表有 timestamp，DTO 暂不暴露，YAGNI） |
| D14 | SecurityModule 显式进 app.module.ts | patched（peer 正确，@Global platform 模块须进 app.module） |
| D15 | apiKey 最小长度 min(8) vs min(1) | host stands（min(8) 防误填） |

**裁决计数**：proven-false ×3（D1/D2/D5b）· conceded ×5（D3/D5a/D6/D8/D10）· patched ×2（D9/D14）· host stands ×2（D11/D15）。

---

## D1 — env 名 + key 编码 + 长度校验

- **Host**：`MODEL_API_KEY_ENCRYPTION_KEY: z.string().min(44)`，base64（32 字节 base64 = 44 字符），生成命令 `openssl rand -base64 32`。
- **Peer**：`MODEL_API_KEY_MASTER_KEY: z.string().min(32)`，"hex 或 base64 32 字节"，`openssl rand -hex 32`。
- **代码证据**：base64 编码 32 字节 → 恰 44 字符（`Buffer.from("...","base64").length === 32` 当且仅当输入 44 字符）。peer 的 `.min(32)` 对 base64 过松（会放过 32-43 字符的非法短 key）；对 hex 又过紧（hex 编码 32 字节 = 64 字符，`min(32)` 放过 32-63 字符非法）。host 的 `.min(44)` 对 base64 精确。
- **裁决**：`proven-false`——peer 的长度校验对两种编码都不精确。保留 host 的 base64 + `.min(44)`（精确匹配 32 字节语义）。env 名 `MODEL_API_KEY_ENCRYPTION_KEY` vs `MODEL_API_KEY_MASTER_KEY` 纯偏好，保留 host（"encryption key" 比 "master key" 更直白表达用途）。

## D2 — e2e DB 策略

- **Host**：`overrideProvider(ModelsRepository).useValue(inMemoryRepo)`，DB-free e2e（对齐 `skeleton.e2e.spec.ts` 现状）。真 PG 集成留 revisit。
- **Peer**（Risk 1）：建议方案 A「真 PG + mock port」，称沿用 `traces.repository.spec.ts` 模式（"需 docker compose infra up"）。
- **代码证据**：
  - `apps/backend/test/traces.repository.spec.ts:1-22`——`buildClient()` 用 `jest.fn()` 构造 **mock** ClickHouse client，断言 `raw.query` 被调用的 SQL 字符串。**不是真 ClickHouse/PG**。peer 引用错误。
  - `apps/backend/test/skeleton.e2e.spec.ts:59-77`——TestingModule `imports` 不含 `PersistenceModule`，直接 import 域模块（当前 mock service）。e2e 全 DB-free。
  - `apps/backend/test/users.service.spec.ts`（peer §G 引）——mock repo，不测 drizzle 查询。
  - 代码库无 drizzle 真 PG repo spec 先例（`users.repository.ts` 也无 spec）。
- **裁决**：`proven-false`——peer 的"traces.repository.spec.ts = 真 PG 模式"事实错误（实为 mock client）。代码库约定是 mock-based 测试。host 的 in-memory mock repo e2e 对齐约定。drizzle 查询正确性靠 TS 类型推断（Drizzle 从 schema 推类型，列名拼错编译失败）+ 手动 `pnpm db:migrate` 运行兜底，与 `users.repository` 现状一致。真 PG 集成测试是未来加固项（revisit），非 M3 范围。

## D3 — baseUrl required vs optional + 默认表

- **Host**：契约 `baseUrl: z.string().url().optional()`；adapter 内置 provider→baseUrl 默认表（OpenAI/DeepSeek/阿里云/智谱）；抽屉恒提交，默认表为兜底。
- **Peer**（Risk 2）：倾向 `baseUrl` 必填，"减少推断复杂度"。
- **裁决**：`conceded`——host 的默认表是死代码（host 自承"抽屉恒提交"），新增 provider 需维护表（YAGNI 违反）。改 `baseUrl` 为必填（写侧 `CreateModelRequestSchema` + 读侧 `ModelProviderSchema` 均必填）。adapter 不需 `resolveBaseUrl`，直接用 `row.baseUrl`。未知/自部署 provider 用户手填 baseUrl（正确行为）。

## D5a — testConnection 用 GET /models vs POST 真路径

- **Host**：LLM/embedding → `GET {baseUrl}/models`（Bearer），200 → `{ok:true, model: first_model_id}`。仅验 auth + 可达。
- **Peer**：LLM → `POST {baseUrl}/chat/completions`（`messages:[{role:"user",content:"ping"}],max_tokens:1`）；embedding → `POST {baseUrl}/embeddings`（`input:"ping"`）；rerank → `POST {baseUrl}/rerank`。测真实调用路径。
- **代码证据**：`GET /models` 只验"账户能列模型"，不验"具体 `name` 模型可 chat/embed"。peer 的 POST 用具体 model name + max_tokens:1，验"该模型真能跑"，token 成本可忽略（≤1 token）。rerank 无 GET list 端点，host 本就用 POST——peer 让三类一致用 POST，更统一。
- **裁决**：`conceded`——用 POST 真路径（chat/completions max_tokens:1 / embeddings input:"ping" / rerank），验具体 model name 可用。三类一致。

## D5b — port 暴露 chat/embed/rerank vs 仅 testConnection

- **Host**：`ModelProviderPort` 仅 `testConnection(config)`。chat/embed/rerank 列 non-goal，M4/M8 扩展 port。
- **Peer**：port 含 `test/chat/embed/rerank` 四方法，"chat/embed/rerank 实现真实调用（M8 chat 路径会用，M3 先可用）"。
- **裁决**：`proven-false`——peer 把 M4（embedding 消费）/M8（chat 编排）的调用接口提前到 M3，属 scope creep。M3 的 testConnection 内部直接 POST chat/completions 即可，不需把 chat/embed/rerank 提升为 port 方法。port 边界最小化（只暴露当前消费方需要的 `testConnection`），M4/M8 再扩。host 不变。

## D6 — crypto 形态

- **Host**：`crypto.ts` 纯函数 `encrypt(plaintext, masterKeyB64)` / `decrypt(blob, key)` / `maskApiKey(plaintext)`。ModelsService 注入 `AppConfigService` 取 key，调纯函数。
- **Peer**：`EncryptionService` class（构造注入 master key，方法 `encrypt(plaintext)` 无 key 参数）+ `SecurityModule`（@Global）+ `ENCRYPTION` DI token（`Symbol`），镜像 ClickHouseModule 模式。
- **代码证据**：
  - `apps/backend/src/platform/clickhouse/clickhouse.module.ts`——@Global + `CLICKHOUSE` token + `useFactory`（peer §3 引）。
  - `apps/backend/src/platform/persistence/persistence.module.ts`——@Global + `DRIZZLE` token（`drizzle.constants.ts:1`）。
  - platform 层约定：跨域共享的基础设施走 @Global + Symbol token + useFactory。
  - 测试：class + token 可 `overrideProvider(ENCRYPTION)` 注入 mock（service spec 不依赖真 key）；纯函数需 mock `AppConfigService` 才能隔离（耦合更深）。
- **裁决**：`conceded`——采纳 peer 的 `EncryptionService` class + `SecurityModule`（@Global）+ `ENCRYPTION` token。API 更干净（`encrypt(plaintext)` 无 key 参数）+ 可测（overrideProvider）+ 对齐 platform module 约定。`crypto.ts` → `encryption.ts`（class）；新增 `security.module.ts` + `security.constants.ts`（`ENCRYPTION = Symbol`）。

## D8 — 列名 api_key_cipher vs api_key_enc

- **Host**：`apiKeyCipher: text("api_key_cipher")`。
- **Peer**：`apiKeyEnc: text("api_key_enc")`。
- **代码证据**：`docs/design/001-rag-platform-architecture.md:81`——`model_providers(id, type, provider, name, base_url, api_key_enc, deployment_id, enabled)`。架构权威用 `api_key_enc`。`:159` 也用 `api_key_enc`。
- **裁决**：`conceded`——改列名 `api_key_enc`（对齐架构权威 001:81）。字段名 `apiKeyEnc`。

## D9 — maskApiKey 边界

- **Host**：`maskApiKey`——长度 ≤8 返回 `"****"`，否则 `首3 + **** + 末4`。
- **Peer**：长度 <8 返回 `****末2`，否则 `首3 + **** + 末4`。
- **裁决**：`patched`——采纳 peer 的边界细化（极短 key 不全 `****`，保留末 2 辅助辨识）。最终：长度 <4 全 `****`；4-8 返回 `**末2`；>8 返回 `首3****末4`。覆盖空串。

## D10 — deploymentId 列

- **Host**：schema 无 `deploymentId`（遗漏）。
- **Peer**：`deploymentId: text("deployment_id").optional()`（对齐 `001:81`）。
- **代码证据**：`001:81` 明列 `deployment_id`。
- **裁决**：`conceded`——补 `deploymentId` 列（nullable text）。M3 虽未用（连通性测试不需），但 schema 须对齐架构权威；M4/M8 可能按 deployment 路由。`ModelProviderSchema` 读 DTO 也补 `deploymentId?`。

## D11 — 读 DTO 是否暴露 createdAt/updatedAt

- **Host**：`ModelProviderSchema`（读 DTO）无 timestamp。表有 `createdAt/updatedAt` 列（host §4 schema 有）。
- **Peer**：`ModelProviderSchema` 加 `createdAt/updatedAt: z.string().datetime()`。
- **裁决**：`host stands`——前端 `ModelsPage` 当前不显示创建/更新时间（无消费方）。表保留 timestamp 列（约定），但读 DTO 暂不暴露（避免无消费方的字段 + mapper 代码 + 测试断言膨胀）。有消费方时再加。YAGNI。

## D14 — SecurityModule 显式进 app.module.ts

- **Host**：未显式说明 SecurityModule 注册位置（隐含 ModelsModule import）。
- **Peer**：`app.module.ts:23-30` imports 紧挨 PersistenceModule 加 SecurityModule。
- **代码证据**：`apps/backend/src/app.module.ts:23-30`——`AppConfigModule, PersistenceModule, ClickHouseModule` 均在 imports 显式列出。@Global platform 模块须显式 import 才能触发 provider 注册。
- **裁决**：`patched`——peer 正确。SecurityModule 须在 `app.module.ts` imports 显式列出（紧挨 PersistenceModule/ClickHouseModule），不能只靠 ModelsModule import（@Global 模块的 provider 注册需在 root 触发）。

## D15 — apiKey 最小长度

- **Host**：`z.string().min(8)`。
- **Peer**：`z.string().min(1)`。
- **裁决**：`host stands`——min(8) 防误填（如 "test"/"key"），无主流 provider key <8 字符（OpenAI `sk-` 51+，DeepSeek 同量级）。min(1) 过松。保留 min(8)。

---

## 应用到 spec.md 的变更（patched/conceded）

已同步更新 `spec.md`：

1. **D3**：`baseUrl` 改必填（写 + 读 schema）；删 adapter 默认表 `resolveBaseUrl`。
2. **D5a**：`OpenAiCompatAdapter.testConnection` 改 POST 真路径（chat/completions `max_tokens:1`、embeddings `input:"ping"`、rerank），删 `GET /models`。
3. **D6**：`crypto.ts` 纯函数 → `encryption.ts` `EncryptionService` class + `security.module.ts`（@Global）+ `security.constants.ts`（`ENCRYPTION` token）。ModelsService 改注入 `@Inject(ENCRYPTION) enc: EncryptionService`（不再注 AppConfigService 取 key）。
4. **D8**：列名 `api_key_cipher` → `api_key_enc`；字段 `apiKeyCipher` → `apiKeyEnc`。
5. **D9**：`maskApiKey` 边界细化（<4 全 `****`；4-8 `**末2`；>8 `首3****末4`）。
6. **D10**：schema 补 `deploymentId: text("deployment_id")`（nullable）；`ModelProviderSchema` 补 `deploymentId?`。
7. **D14**：`app.module.ts` imports 显式加 `SecurityModule`。

保留不变（host stands / proven-false）：D1（env 名 + min(44) base64）、D2（in-memory mock e2e）、D5b（port 仅 testConnection）、D11（DTO 不暴露 timestamp）、D15（apiKey min(8)）。
