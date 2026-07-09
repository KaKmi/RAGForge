# M3 Diff Report — host spec vs peer spec

> Host: `spec.md`（Claude）；Peer: `peer-spec.md`（Codex，独立调查）。
> 两份 spec 在核心结构上一致：契约读写分离（写侧明文 apiKey / 读侧仅掩码）、AES-256-GCM 应用层加密 + env 主密钥 fail-fast、域内 Drizzle schema + repository（prompts 范式）、`ModelProviderPort` + OpenAI 兼容 adapter（DI token、Node fetch、不引新依赖）、ad-hoc `POST /models/test`（保存前验活）、`withSpan` + `gen_ai.*` 常量埋点、e2e in-memory repo + fake port、破坏测试清单（skeleton.e2e / m2-schemas / config.schema.spec）。以下仅记录分歧。

## D1 — `role` 字段是否持久化 · **conceded（采 peer）**

- Host 原稿：保留 `role` optional 于契约 + DB（nullable text），前端"用途"列显示。
- Peer：001:81 权威表 `model_providers(id,type,provider,name,base_url,api_key_enc,deployment_id,enabled)` **无 role**；M2 mock 字段不应未经改文档就落库（peer-spec.md:35,160）。
- 证据：001:81 确无 role；CLAUDE.md"改架构先改文档"。
- 处置：**conceded**。契约与 DB 删 role；前端"用途"列由 `MODEL_TYPES[type].hint` 派生；真实用途 M7 由 Agent 绑定派生。

### D1a — 附带争议：`created_at/updated_at` 是否同理禁止 · **proven-false（驳 peer）**

- Peer 主张连时间戳列也须先改 001 文档（peer-spec.md:47）。
- 证据：`users/schema.ts:9-10`、`prompts/schema.ts:12-14` 均带 createdAt/updatedAt，而 001:80/88 的表清单同样未列出——工程簿记列不属架构决策，仓库先例明确。
- 处置：**proven-false**。时间戳保留。

## D2 — 密文 envelope 格式 · **conceded（采 peer）**

- Host 原稿：`base64(iv|tag|ct)` 单 blob。
- Peer：`v1:<ivB64>:<tagB64>:<ctB64>` 版本化 envelope（peer-spec.md:62）。
- 裁决：001:159 预告云上换 KMS，版本前缀为未来密文并存/迁移留判别标识，成本为零。**conceded**。

## D3 — baseUrl 与 canonical 路径重复拼接 · **patched（peer 发现，host 扩展）**

- Host 原稿：只做尾部 `/` 归一化。
- Peer：若 baseUrl 已以 `/rerank` 结尾则不重复拼（peer-spec.md:94）——原型默认 base `http://infra.internal:8080/rerank`（mocks/models.ts:53）就是全路径形态。
- 处置：**patched**，且扩展到三条 canonical 路径（`/chat/completions`、`/embeddings`、`/rerank`）统一去重；同时前端 `MODEL_TYPES` 默认 base 改为根形态 URL（我们自己的 UX 常量，消除歧义源头）。

## D4 — model 参数取值 · **conceded（采 peer）**

- Host 原稿：`model: name`。
- Peer：`model: deploymentId ?? name`（peer-spec.md:92-94）——deployment_id 列（001:81）本就为 Azure 型部署标识设计。
- 处置：**conceded**，`ModelCallConfig` 补 `deploymentId?`。

## D5 — Port 是否预留 `chat?/embed?/rerank?` 可选方法 · **proven-false（驳 peer）**

- Peer：接口预留可选方法呼应 001:95 终态（peer-spec.md:78-86)。
- 裁决：001:95 终态正确，但**可选**方法迫使 M4/M8 消费方判 undefined，弱化类型安全；届时按需加**必选**方法是非破坏扩展。M3 接口只含 `testConnection`。
- 处置：**proven-false**（保留 host 设计，spec 已注明终态出处）。

## D6 — TestModelResponse 形状 · **patched（互采）**

- Host 原稿：`{ok, latencyMs?, model?, error?}`；Peer：`{ok, latencyMs?, statusCode?, message?}`。
- 处置：**patched** 为 `{ok, latencyMs?, statusCode?, error?}`——采 peer 的 statusCode（UI 提示有用）、弃 host 的 model 回显（调用方已知）、字段名保留 error（host 命名）。

## D7 — 掩码规则 · **conceded（采 peer，简化）**

- Host 原稿：三分支（<4 / 4-8 / >8）。
- Peer：两分支：len≥8 → `首3+"****"+末4`，否则 `"****"`（peer-spec.md:62）——输出与 M2 mock 展示格式 `sk-****1234` 一致，且 create 侧 `apiKey.min(8)` 使短分支几乎不可达。
- 处置：**conceded**。

## D8 — 测试成功判定是否校验响应形状 · **conceded（采 peer）**

- Host 原稿：2xx 即 ok。
- Peer：2xx 且轻量形状校验（`choices` / `data[0].embedding` / `results|data`）（peer-spec.md:92-94）——防"网关 200 但模型名不存在"假阳性。
- 处置：**conceded**。

## D9 — 超时可配置 env · **proven-false（驳 peer）**

- Peer：`MODEL_PROVIDER_TEST_TIMEOUT_MS` env 可调（peer-spec.md:96）。
- 裁决：M3 无调参需求，加 env 即加配置面与测试面；YAGNI。固定 10s 常量导出（比 peer 的 8s 略宽，容忍慢自部署冷启动）。
- 处置：**proven-false**（不加 env）。

## D10 — 加密服务落位 · **proven-false（驳 peer）**

- Peer：新建 `platform/crypto/`（peer-spec.md:53）。
- 证据：`platform/security/` 已存在且承载安全原语（public.decorator / authenticated-user），加密属同域；不必新增平台目录。
- 处置：**proven-false**，落 `platform/security/encryption.ts` + `SecurityModule`。

## D11 — Create schema 是否 `.strict()` 拒收 `apiKeyMasked` · **proven-false（驳 peer）**

- Peer：strict object 显式拒绝 apiKeyMasked（peer-spec.md:36）。
- 证据：contracts 全包 grep 无任何 `.strict()` 用法——默认 strip 未知键是仓库既有约定；单点 strict 造成行为不一致。
- 处置：**proven-false**。omit 后未知键静默剥离即可（测试断言 create 后响应/DB 无明文已覆盖风险）。

## D12 — 前端挂载测试 · **conceded（采 peer，host 遗漏）**

- Host 原稿测试计划无前端测试。
- Peer：`App.test.tsx:68-92` 已有 M6 PromptsPage 真 API 挂载测试范式，M3 应对齐（peer-spec.md:134,142）。
- 处置：**conceded**，测试计划补 `/admin/models` 挂载断言。

## 其余未采纳的小项（无争议记录）

- Peer `apiKey: min(1)` vs host `min(8)`：保留 host（误填防护；掩码规则也以 ≥8 为主分支）。
- Peer Update schema "至少一个字段" refine：不采——空 PATCH 是无害 no-op，refine 徒增 DTO 复杂度。
- Peer `gen_ai.system` 可用 `"openai-compatible"`：保留 host（用 provider 名，信息量更大）。
- Peer rerank documents 用 `["ping","pong"]`：采纳（两条文档让 rerank 更真实），已并入 spec。

## 结论

12 项分歧：conceded 6（D1/D2/D4/D7/D8/D12）、patched 2（D3/D6）、proven-false 4（D1a/D5/D9/D10/D11 计 5 处，D1a 为 D1 附带）。**escalated 0** — 无需用户裁决。spec.md 已全部合入。
