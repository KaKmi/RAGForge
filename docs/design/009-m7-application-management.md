---
title: "M7 应用管理与配置发布"
description: "应用以不可变配置版本和单一生产指针发布，上线前异步执行真实 NodeRuntime 预演。"
category: "design"
number: "009"
status: not-implemented
services: [backend, frontend, contracts, chat, node-runtime]
related: ["design/001", "design/002", "design/003", "design/008", "design/011", "design/012"]
last_modified: "2026-07-11"
---

# 009 — M7 应用管理与配置发布

## Status

`not-implemented`。2026-07-11 根据最新版 `RAG知识库问答系统设计/CodeCrushBot.dc.html`、聚焦原型 `RAG知识库问答系统设计/应用详情·Playground.dc.html`、011 NodeContract 执行引擎和 012 Prompt 管理重构重新完成架构设计。

本版取代本文同日早先的“应用配置版本也使用排他标签、production 门禁只做静态校验”方案。最新聚焦原型只表达一个“服务中版本”，且上线自检要求在真实应用知识库和节点参数下查看四个节点的运行结果。因此最终设计采用 `applications.production_config_version_id` 单指针，并把上线门禁拆成静态检查与异步真实 NodeRuntime 预演。

当前代码仍是旧 M7：`apps/backend/src/modules/agents/`、`agents.current_version_id`、`agent_config_versions.status/eval_*`、v1 自动发布和 Eval stub。本文描述的 applications 模块、无状态不可变版本、真实 release check 与新 API 尚未实现，不能标记为 `current`。旧 `008-m7-agent-management.md` 曾记录该实现；因其与 M5 的 008 编号冲突，目标设计规范化为 009，迁移历史保留在本文。

## 决策更新 · 2026-07-11（应用版本命名标签，复议“单指针”）

> **本节记录一次对下文核心决策的复议，尚未整合进正文；正文其余部分仍描述旧“单指针”方案，冲突处以本节为准，M7b design 时统一回改。M7a 已交付部分不受影响。**

用户（产品）明确新需求：应用配置版本需要**自定义命名标签**（如 `qa20260707`），作为版本的稳定、可读**访问锚点**——

- 打标签后该标签稳定指向打标签时的那个版本；之后新增版本不影响它（等价于 git tag）。
- 前端可经 `chat/{应用 slug 或 id}/{标签}` 直接解析到该版本对话（QA 验收、分享、留存书签）。
- `production` 降为一个**保留标签**（决定不带标签访问时的默认版本）；`qa20260707`/`beta` 等为用户自定义锚点。

这**推翻**本文原“单一 `production_config_version_id` 指针 + 明确拒绝应用标签”的决策，涉及冲突处：§Status 第 3 段（“取代早先标签方案”）、§Out-of-scope「应用级自定义标签」、§Context 末段（“不能照搬 Prompt 标签表”）、§Invariants、§编辑保存上线（“不能退回指针+标签双写”）、§Alternatives「生产选择」、§Assumptions「不需要 beta/staging 别名」、§Revisit triggers。原否决理由是“原型只有单一服务中版本，标签是过度设计”；新用例揭示标签价值不在多环境灰度，而在**版本的命名可读引用**，该理由不再成立。

**新方向（M7b 落地，需在 M7b design 细化并回改本文正文）：**

- 新增应用版本命名标签表：应用内标签名唯一；移动语义为“同名标签排他地从旧版本移到新版本”（复用 012 Prompt 标签的排他移动范式，但归属 applications 域，仍不与 Prompt 标签耦合）。
- `production` 为保留标签，决定公开默认解析；其余为自定义锚点。上线/回滚 = 移动 `production` 标签（与原“移动单指针”语义等价，只是 production 成为标签之一）；ReleaseCheck 仍在移动 production 前执行。
- 运行时解析扩展为 `resolve(applicationIdOrSlug, tag?)`：带 tag 解析到标签指向版本，不带则用 production；沿用 deleted → disabled → 目标缺失 → resolved 的拒绝顺序。
- 前端：`/chat/:appIdOrSlug/:tag?` 路由 + 版本历史「管理标识」弹窗（打/移/摘标签，原型 `CodeCrushBot.dc.html` 已画该弹窗）。M7a 详情页暂未做此弹窗（属 M7b）。

**标签写入与列表展示细则（2026-07-11 追加）：**

- 标签在应用内**排他**：一个标签名同一时刻只属于一个版本（复用 012 Prompt 标签的“同名标签唯一”约束）。
- 给某版本打一个**当前指向别的版本**的标签时，前端须**提示“将从 vX 移动到本版本”**（移动确认，对应原型「管理标识」弹窗“beta 当前指向 v13，勾选将移动到此版本”那条橙色提示）。
- 打的标签若是保留字 `production`，**不是简单移动标签，而是走上线流程**（先 ReleaseCheck，通过后再原子移动 production 指针）；其余自定义标签的移动即时生效、无上线副作用与 ReleaseCheck。
- 应用列表：在「标识」列（展示该应用生产版本携带的标签 / 自定义标签）之外，**单加一列「是否上线」**明确上线状态（已上线 vN / 未上线），把“有哪些标签”与“是否对外服务”两件事拆开。M7a 阶段仅有 `production` 概念、两列信息重叠；M7b 引入自定义标签后「标识」列展示 `qa20260707` 等锚点、不再与「是否上线」重复。**（M7a 已按此拆分列表两列。）**

- 待澄清（M7b design 决）：标签是否可被非管理员经 URL 直达（安全/可见性）；自定义标签数量上限；`production` 之外是否还需 `beta` 保留字；移动 `production`（上线）与移动自定义标签是否共用同一「管理标识」入口但分流程。

## Summary

应用是一份完整 RAG 运行配置：知识库集合、四个固定节点各自引用的 PromptVersion、模型和生成参数，以及检索、重排和兜底策略。编辑态只存在于前端；点击“保存为新版本”追加不可变 ApplicationConfigVersion；点击“上线这个版本”先创建异步 ReleaseCheck，检查通过后再以乐观并发方式原子移动 `production_config_version_id`。

Prompt 标签与应用发布完全解耦。Prompt 的 `production/beta` 仅是 Prompt 域内的管理标识，移动它不会改变任何应用。应用版本始终固定引用具体 PromptVersion；PromptVersion 固定 ContractVersion。公开问答只读取应用 production 指针，管理员对话测试可显式选择任意已保存版本。

## Boundaries

### In-scope

- 应用列表、详情、新建、基础信息编辑、停用/恢复、下线和删除。
- 前端临时编辑态、保存不可变应用配置版本、版本历史和载入编辑。
- 版本级知识库集合、四节点 PromptVersion/模型/生成参数、检索与兜底快照。
- 单一 `production_config_version_id` 的上线、回滚和下线语义。
- 上线前静态检查 + 异步真实 NodeRuntime 预演，结果以短期 ReleaseCheck artifact 保存。
- 应用版本对话测试；Prompt 失败问题跳转到 Prompt 试运行并带入应用上下文。
- applications 域提供 Prompt 页面“谁在用”的只读派生查询。
- 从旧 agents 三态/Eval stub 模型迁移。

### Out-of-scope

- 应用级 `beta/staging` 自定义标签、灰度权重和多环境路由。
- M11 的完整评测集管理、质量报表和人工审批流。
- 任意节点/DAG；首期固定 rewrite/intent/reply/fallback 四节点。
- 多租户/RBAC；当前沿用单管理员 JWT 边界。
- 冻结知识库内容版本；应用固定知识库集合，但知识库 active version 可以独立演进。
- 把 Prompt 标签解释为应用运行依赖。

### Invariants

1. **应用配置版本业务字段不可修改**；任何变更必须追加新版本。
2. **只有已保存版本可以检查或上线**；前端未保存编辑态不得进入生产流程。
3. **应用版本固定 PromptVersion，PromptVersion 固定 ContractVersion**；运行时不解析 Prompt 标签。
4. **Prompt 标签移动永不影响应用**，包括 Prompt 的 `production` 标签。
5. **应用只有一个 production 指针**；公开问答不能选择任意版本。
6. **上线确认必须引用 passed、未过期且 fingerprint 匹配的 ReleaseCheck**。
7. **真实预演与 Prompt 试运行、正式 chat 共用 NodeRuntime**；applications 不自行拼 Prompt 或解析模型输出。
8. **ReleaseCheck 不在数据库事务内等待模型**；最终 production 更新只使用短事务。
9. **停用高于 production**；恢复服务不改变 production 指针。
10. **观测故障不进入问答关键路径**，承接 001 全局不变量。

## Context

旧 M7 把“保存”“验证”“发布”压进两套状态机：版本 `draft/published/archived` 和 Eval `not_run/passed/exempt`。新建 v1 自动上线，Eval 在 M11 缺位时硬编码通过。新版原型改变了这一语义：编辑已有版本产生未保存修改，保存追加新版本，新版本默认未上线；上线时依次核对四节点实际回答，发现未在当前应用真实知识库上下文中验证的问题则阻断并引导去 Prompt 试运行。

012 同时把 Prompt 改成版本平权 + 标签模型，但明确规定 Prompt 标签没有发布语义。应用不能照搬 Prompt 标签表，否则会把两个不同领域再次混为一谈。应用原型只有一个服务中版本，单一生产指针是满足需求的最简单事实源。

## Goals / Non-goals

### Goals

- 线上配置可精确定位、可测试、可原子切换和回滚。
- 保存不等于上线；上线不接受未持久化内容。
- Prompt 的任何编辑或标签移动都不会静默改变线上应用。
- 发布问题能落到具体节点、PromptVersion、样例和 Trace，并提供可执行修复入口。
- 当前 production 在新版本检查失败、队列故障或模型故障时继续服务。

### Non-goals

- 不承诺一次 ReleaseCheck 等价于 M11 的语义质量评测。
- 不保存完整预演输入/输出到 Postgres。
- 不为低频发布提前引入独立配置中心或 Redis。

## Requirements & numbers

| 维度 | 假设/目标 | 算术与结论 |
|---|---|---|
| 应用规模 | 100 个 | 管理列表低频；超过 1,000 再分页/物化 |
| 版本规模 | 平均 50 版本/应用 | `100 × 50 = 5,000` 行 |
| 配置体积 | 每版本约 2–5 KB | 总量约 10–25 MB，Postgres 足够 |
| 公开问答 | 持续 20 QPS | 单指针 join p95 目标 `<10ms` |
| 静态门禁 | 只读数据库 + 纯函数 | p95 目标 `<500ms` |
| 真实预演 | rewrite/intent 各 10 例，reply/fallback 各 1 例 | 共 22 次 NodeRuntime 调用 |
| 预演耗时 | 单次平均 2s，并发 4 | `ceil(22/4) × 2 ≈ 12s`；慢模型可能 30–60s，必须异步 |
| 检查有效期 | 15 分钟 | 约束依赖变化窗口，同时允许人工确认 |
| 发布切换 | 一次 CAS + 更新时间 | 短事务 p95 目标 `<100ms` |

每天 10 次发布检查即 220 次节点调用，仍是低频控制面负载。每天超过 100 次或成本异常时再增加配额、样例缓存或分层检查。

## Design

### 领域组件

- `applications`：应用身份、production 指针、停用/删除状态。
- `application-configs`：前端 DTO 校验、不可变版本创建、列表与详情。
- `release-checks`：静态门禁、样例选择、队列任务、fingerprint 和结果摘要。
- `ApplicationConfigResolver`：公开问答和管理员测试共用的版本解析端口。
- `node-runtime`：接收 applications 准备的节点配置与运行上下文，执行真实预演；不依赖 applications。
- `prompts`：Prompt/PromptVersion/标签/编译与试运行；保持叶子，不依赖 applications。
- `chat`：只经 applications barrel 获取 ResolvedApplicationConfig。

### 数据模型

```text
applications
  id                            uuid PK
  slug                          text NOT NULL UNIQUE
  name                          text NOT NULL UNIQUE
  description                   text NOT NULL DEFAULT ''
  enabled                       boolean NOT NULL DEFAULT true
  production_config_version_id  uuid NULL
  deleted_at                    timestamp NULL
  created_by                    text NOT NULL
  created_at                    timestamp NOT NULL DEFAULT now()
  updated_by                    text NOT NULL
  updated_at                    timestamp NOT NULL DEFAULT now()

application_config_versions
  id                          uuid PK
  application_id              uuid NOT NULL REFERENCES applications(id)
  version                     integer NOT NULL
  config_schema_version       integer NOT NULL DEFAULT 1
  prompt_rewrite_version_id   uuid NOT NULL REFERENCES prompt_versions(id) ON DELETE RESTRICT
  prompt_intent_version_id    uuid NOT NULL REFERENCES prompt_versions(id) ON DELETE RESTRICT
  prompt_reply_version_id     uuid NOT NULL REFERENCES prompt_versions(id) ON DELETE RESTRICT
  prompt_fallback_version_id  uuid NOT NULL REFERENCES prompt_versions(id) ON DELETE RESTRICT
  rewrite_model_id            uuid NOT NULL REFERENCES model_providers(id) ON DELETE RESTRICT
  intent_model_id             uuid NOT NULL REFERENCES model_providers(id) ON DELETE RESTRICT
  reply_model_id              uuid NOT NULL REFERENCES model_providers(id) ON DELETE RESTRICT
  fallback_model_id           uuid NOT NULL REFERENCES model_providers(id) ON DELETE RESTRICT
  rerank_model_id             uuid NULL REFERENCES model_providers(id) ON DELETE RESTRICT
  node_params                 jsonb NOT NULL
  retrieval_params            jsonb NOT NULL
  fallback_params             jsonb NOT NULL
  note                        text NULL
  created_by                  text NOT NULL
  created_at                  timestamp NOT NULL DEFAULT now()

  UNIQUE(application_id, version)
  INDEX(application_id, created_at DESC)

application_config_version_kbs
  config_version_id  uuid NOT NULL REFERENCES application_config_versions(id) ON DELETE CASCADE
  kb_id              uuid NOT NULL REFERENCES knowledge_bases(id) ON DELETE RESTRICT
  PRIMARY KEY(config_version_id, kb_id)
  INDEX(kb_id)

application_release_checks
  id                  uuid PK
  application_id      uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE
  config_version_id   uuid NOT NULL REFERENCES application_config_versions(id) ON DELETE CASCADE
  config_fingerprint  text NOT NULL
  status              text NOT NULL -- queued|running|passed|failed|expired
  issues              jsonb NOT NULL DEFAULT '[]'
  sample_summary      jsonb NOT NULL DEFAULT '{}'
  started_at          timestamp NULL
  finished_at         timestamp NULL
  expires_at          timestamp NULL
  created_by          text NOT NULL
  created_at          timestamp NOT NULL DEFAULT now()

  INDEX(application_id, config_version_id, created_at DESC)
  INDEX(status, created_at)
```

`production_config_version_id` 必须属于同一 application。若循环 FK 不能方便地声明为 deferred，首期由 service 写入顺序和事务内归属校验保证；不能退回“指针 + 标签”双写。

### 节点和检索配置契约

```ts
interface ApplicationNodeConfig {
  promptVersionId: string;
  modelId: string;
  freedom: "precise" | "balance" | "improvise" | "custom";
  temperature: number;
  topP: number;
}

interface ApplicationConfigFields {
  kbIds: string[];
  nodes: Record<PromptNode, ApplicationNodeConfig>;
  retrieval: {
    schemaVersion: 1;
    topK: number;
    topN: number;
    hybridEnabled: boolean;
    vectorWeight: number;
    rerankEnabled: boolean;
    rerankModelId?: string; // DTO 字段，repository 映射到独立 FK 列
    rerankThreshold?: number;
  };
  fallback: { toHuman: boolean };
}
```

所有 JSONB 写入前必须由 contracts 中 strict Zod schema 校验。Prompt 下拉可以展示标签、最新和“谁在用”提示，但持久化只保存 PromptVersion ID。

### 编辑、保存和上线

编辑态仅存在于前端：

```ts
interface ApplicationConfigDraft {
  basedOnVersionId: string | null;
  fields: ApplicationConfigFields;
  dirty: boolean;
}
```

- 载入生产或历史版本只生成前端副本，不修改数据库。
- “保存为新版本”创建下一不可变版本，允许存在 Prompt 编译错误或尚未验证的问题。
- dirty 编辑态禁止检查/上线；后端只接受真实 configVersionId。
- “上线这个版本”先创建 ReleaseCheck，不自动偷存新版本。
- 回滚等价于对历史版本重新做有效 ReleaseCheck 后移动 production 指针；不能因为它曾上线过就跳过当前依赖检查。

### Prompt 版本选择

应用可选择对应节点下的所有 PromptVersion，不按 Prompt 标签过滤。保存时校验版本存在、Prompt node 匹配、ContractVersion 存在。`compile_status=has_errors` 仍允许保存，以支持中间版本记录，但静态发布门禁必须阻断。

Prompt 标签移动、摘除或创建不会触发应用更新。PromptVersion 被任意应用版本引用时受 FK RESTRICT 保护。

### 上线门禁

第一层静态检查不调用模型：

1. 至少一个知识库；Embedding 模型和维度一致。
2. 四个 PromptVersion 存在、节点归属正确、ContractVersion 存在。
3. Prompt 编译无错误。
4. 四个 LLM 模型存在、启用且类型正确。
5. rerank 开启时模型合法。
6. `topN <= topK`；权重、阈值、temperature 和 Top P 在合法值域。
7. NodeRuntime 支持 config schema 与 ContractVersion。

第二层通过 NodeRuntime 真实预演：rewrite/intent 各 10 例，reply/fallback 各 1 冒烟。applications 负责提供应用配置、样例、模型参数、知识库派生的 `availableRoutes`、检索上下文和 citations；NodeRuntime 负责组装、模型调用、Schema/动态校验、一次修复和 Fallback。

011 的跨域接口修订为：

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

interface NodeRuntimeService {
  compileAndSample(request: NodeSampleRequest): Promise<NodeSampleResult>;
}
```

applications 逐节点调用该接口；NodeRuntime 不负责选择应用版本、知识库或生产指针。

### ReleaseCheck fingerprint

fingerprint 至少包含：ApplicationConfigVersion ID、四个 PromptVersion/ContractVersion、模型 ID 与 provider revision、节点参数、知识库 ID 集合和检查时的 KB active version。检查通过后默认 15 分钟有效；依赖改变或超时后不能用于上线。

Postgres 只保存错误代码、节点、样例序号、fallback 标记、统计和 Trace ID，不保存完整模型输入/输出。详细过程由受脱敏策略约束的 Trace 承载。

### 运行时解析

```ts
interface ApplicationConfigResolver {
  resolvePublic(applicationIdOrSlug: string): Promise<ResolvedApplicationConfig>;
  resolveForTest(applicationId: string, configVersionId: string, actor: Admin): Promise<ResolvedApplicationConfig>;
}
```

公开解析顺序：deleted → disabled → production missing → resolved。管理员对话测试可以指定任何已保存版本，Trace 标记 `rag.preview=true`，不能污染正式会话统计。

### API

| 操作 | 方法与路径 | 说明 |
|---|---|---|
| 列表/详情 | `GET /api/applications`、`GET /api/applications/:id` | 返回生产摘要和停用状态 |
| 新建 | `POST /api/applications` | 创建应用和未上线 v1 |
| 编辑基础信息 | `PATCH /api/applications/:id` | 仅 name/description/enabled |
| 删除 | `DELETE /api/applications/:id` | 删除配置/检查，保留历史解释策略 |
| 版本列表/详情 | `GET /api/applications/:id/config-versions[...]` | 只读不可变快照 |
| 新建版本 | `POST /api/applications/:id/config-versions` | 追加版本，不上线 |
| 对话测试 | `POST /api/applications/:id/config-versions/:versionId/chat` | 管理员显式版本测试 |
| 开始检查 | `POST /api/applications/:id/config-versions/:versionId/release-checks` | 静态失败返回 422，否则创建异步检查 |
| 检查状态 | `GET /api/applications/:id/release-checks/:checkId` | 轮询或配合 SSE |
| 上线/回滚 | `PUT /api/applications/:id/production` | 需要 passed check + expected pointer |
| 下线 | `DELETE /api/applications/:id/production` | 清空指针，应用保留 |
| Prompt usage | `GET /api/applications/prompt-usage?promptId=:id` | applications 域只读派生视图 |

上线请求：

```json
{
  "versionId": "uuid",
  "releaseCheckId": "uuid",
  "expectedProductionVersionId": "uuid-or-null"
}
```

短事务内校验 check 归属/status/expiry/fingerprint、expected production 和关键依赖，然后更新指针、updatedBy/updatedAt 并写审计事件。并发发布后提交者收到 409，必须刷新后重新确认。

### Prompt 试运行协作

Prompt 试运行验证单个 PromptVersion；ReleaseCheck 验证四节点、模型、知识库和参数组合。单次 Prompt 试运行成功不能永久豁免应用检查。

ReleaseCheck 失败 issue 可返回 `OPEN_PROMPT_TRY_RUN` action，携带 applicationId、configVersionId、node、promptVersionId、sampleIndex 和 traceId。Prompt 页面据此加载相同模型参数与应用上下文。修复 Prompt 会生成新 PromptVersion；应用选择它并保存新的 ApplicationConfigVersion 后重新检查。

### “谁在用”查询

applications 域从 `applications.production_config_version_id → application_config_versions → 四个 prompt_version_id` 派生生产使用关系，返回应用 ID/name、应用配置版本和节点。PromptsService 不依赖 applications；Prompt 前端单独调用该只读端点，失败时隐藏增强信息，不阻塞编辑主体。

## Failure modes

| 场景 | 行为 |
|---|---|
| release 队列不可用 | 不能开始新检查；当前 production 继续服务 |
| 模型/NodeRuntime 超时 | 样例失败并记录；检查失败或按明确策略降级，production 不变 |
| worker 重复投递 | check ID 幂等；已完成任务不再次计费执行 |
| 检查后 KB/provider 变化 | fingerprint 不匹配，确认上线返回 409 |
| 两管理员同时上线 | expected pointer CAS，后提交者 409 |
| Prompt 标签移动 | 应用与 production 完全不变 |
| PromptVersion 删除被引用 | FK RESTRICT 转 409，不裸露 500 |
| dirty 编辑态请求上线 | 前端禁用；后端因无真实版本 ID 拒绝 |
| 摘除 production | 公开地址显示未上线；历史版本保留 |
| 应用停用 | 优先拒绝公开解析；恢复沿用原指针 |
| 观测后端故障 | 保存最小检查摘要；不改变正式问答结果 |

## Rollout & operations

1. 先落地 012 Prompt 版本平权、compile 字段和 Prompt 标签，保持应用仍固定 PromptVersion。
2. 落地 011 NodeRuntime 与修订后的 `compileAndSample(request)`。
3. 为旧 `agents.current_version_id` 迁移到 `applications.production_config_version_id`；旧 published 版本成为普通不可变版本。
4. 新增 release_checks 与 worker；保留旧 publish/eval API 只读兼容窗口。
5. 前端切到应用详情 Playground：前端编辑态、保存新版本、异步核对、问题跳转和确认上线。
6. chat 切到 ApplicationConfigResolver；Prompt usage 查询切到 production 指针。
7. 验证后删除 `status/eval_*/published_*` 和旧 eval/publish/rollback API，最终把 agents 目录/契约改名为 applications。

在删除旧字段前，可从旧 current pointer 回滚读路径；删除旧状态机和公开 API 改名属于 one-way door，必须在所有消费者迁移后执行。

### Observability

控制面事件：`application.config_version.created`、`application.release_check.*`、`application.production.changed/cleared`、`application.disabled/enabled/deleted`。

指标：release check 耗时/结果/节点问题/模型调用数，production change 结果，public resolve 结果与耗时。

Trace 属性：

```text
rag.application.id
rag.application.config_version_id
rag.application.config_version
rag.application.release_check_id
rag.prompt.version_id
rag.prompt.contract_version
rag.node.name
rag.preview
rag.validation.error_code
rag.fallback.used
```

## Security

- 管理、显式版本对话测试和 ReleaseCheck 仅管理员可用；公开用户只访问 production。
- ReleaseCheck 输入可能含真实用户问题，Postgres 不保存完整内容，日志和 Trace 遵循脱敏规则。
- 对话测试、预演和真实发布都要限流并记录成本，不得暴露模型密钥/System 全文。
- 上线、下线、停用、恢复和删除必须审计。
- 当前没有新增租户边界；引入多租户时所有表、查询、队列任务和唯一键必须增加 tenant scope。

## Alternatives considered

| 决策 | 选择 | 拒绝方案 | 决定因素与代价 |
|---|---|---|---|
| 生产选择 | 单一 production 指针 | 复制 Prompt 标签模型 | 原型只有单服务版本；放弃预留自定义环境标签 |
| Prompt 绑定 | 固定 PromptVersion ID | 跟随 Prompt production | 防止标签移动导致线上漂移 |
| 编辑态 | 前端临时 draft | 数据库 draft version | 避免重建版本状态机；刷新前未保存内容会丢失 |
| 门禁 | 异步真实 NodeRuntime 预演 | 纯静态检查 | 原型要求看真实节点结果；增加耗时与模型成本 |
| 检查结果 | 短期 ReleaseCheck | 永久 validated 字段 | 依赖会变化；需要过期/fingerprint 逻辑 |
| 并发发布 | expected pointer CAS | 最后写入者覆盖 | 避免无感覆盖；冲突者需刷新重试 |
| Prompt 试运行 | 修复入口 | 单次成功永久豁免 | 单节点结果不能证明组合正确 |
| 预演输出 | Trace + DB 摘要 | 全量 JSONB 持久化 | 降低 PII/存储风险；详情依赖 Trace 可用性 |

## Assumptions

1. 应用只有一个 production 环境，不需要 beta/staging 应用别名。
2. Prompt 标签继续存在，但只作为 Prompt 域管理信息。
3. ReleaseCheck 可真实调用模型并产生可控费用。
4. 首期样例数沿用 011：rewrite/intent 各 10，reply/fallback 各 1。
5. PromptVersion body 与 ApplicationConfigVersion 都不可变。
6. 知识库内容允许独立更新，不由应用版本冻结。
7. 只有已保存版本能测试、检查和上线。
8. 当前单管理员角色可以执行全部发布动作。

## Revisit triggers

1. 需要 staging/beta 环境路由：设计 application release channels，不复用 Prompt 标签表。
2. 每天 ReleaseCheck 超过 100 次或成本异常：增加配额、样例缓存和分层门禁。
3. 22 次预演 p95 超过 60 秒：重估并发、样例数和离线评测集。
4. KB 更新频繁导致大量检查失效：重定义 fingerprint 或冻结 KB active version。
5. 引入审批流：production 更新升级为 release request + approver。
6. 应用超过 1,000：为 Prompt usage 和列表增加专用索引/物化视图。
7. 多租户落地：所有应用、版本、检查和队列任务增加 tenant scope。

## References

- `RAG知识库问答系统设计/CodeCrushBot.dc.html`：完整新版管理台原型。
- `RAG知识库问答系统设计/应用详情·Playground.dc.html`：应用详情、编辑态、版本历史、真实上线自检与 Prompt 修复跳转。
- `docs/design/011-prompt-assembly-node-contracts.md`：NodeRuntime 和真实样例执行接口提供方。
- `docs/design/012-prompt-management-redesign.md`：Prompt 版本/标签、试运行和“谁在用”协作边界。
- `docs/design/008-m5-retrieval.md`：检索参数和 RetrieverPort。
- `packages/contracts/src/agents.ts`、`apps/backend/src/modules/agents/`：需要迁移的旧 M7 实现。
