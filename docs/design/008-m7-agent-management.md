---
title: "M7 Agent 配置与管理"
description: "M7 设计：agents/agent_config_versions/agent_config_version_kbs 三表版本化模型、复用 M6 promote() 范式、Eval 门槛硬编码占位待 M11 替换。"
category: "design"
number: "008"
status: current
services: [backend, frontend]
related: ["design/001", "design/002", "design/006", "design/007"]
last_modified: "2026-07-09"
---

# 008 — M7 Agent 配置与管理

## Status

`draft` — 经独立 peer 调查（Plan 子代理，未预设结论，独立走查产品文档/原型/既有代码后产出方案）+ host 自查（按 CLAUDE.md 对抗强度分级：M7 属于「轻量对抗」档，peer 独立调查 + diff，跳过 execution drill；本文档 Design 章节的四个场景走查即为自查记录）完成。4 项产品分歧点已由用户当场拍板（2026-07-09）：

1. 知识库绑定允许在「新建配置版本」时改绑（非 Agent 级终身锁定）。
2. Eval 门槛本波「写死」为硬编码 stub（非人工必填理由确认，非原型字面固定假数字），M11 评测系统落地后再替换真实实现。
3. Agent 列表「编辑」入口收窄为仅 `name`/`desc`/`enabled`。
4. Agent 创建时自动生成的首个配置版本（v1）豁免 Eval 门槛，直接上线。

实现落地并对照代码校验后推进为 `current`。

2026-07-09 更新：M7 实现已完成并对照代码校验通过，推进为 `current`。三表 schema（迁移 0008）/ `promote()` 事务 / Eval stub / 编辑收窄 / 后端一致性校验均按本文档落地；24 单测 + 59 e2e + 真实 Postgres 冒烟 + 浏览器全流程走查通过。实现期两处非设计级偏差记录于 `.ship/tasks/m7-agent-management/dev-ledger.md`（错误文案未含 embedding 模型名的有意简化；`GET /agents` 列表每行额外 2 次版本/kb 查询，管理台量级可接受，M8 复用时重估）。

## Summary

M7 把 Agent 管理从 M2 的内存 mock（`MOCK_AGENTS` 数组，无 schema、无持久化）换成真实实现：拆分 `agents`（身份 + 当前生产版本指针）/ `agent_config_versions`（版本化配置快照：模型 + 4 个 Prompt 节点 + 检索参数 + Eval 状态）/ `agent_config_version_kbs`（版本级知识库快照）三张表，复刻 M6 `prompts` 模块已验证过的「版本 + 发布/回滚」范式（`promote()` 单一入口、`currentVersionId` 派生 status、乐观重试递增版本号）。核心产品语义「一次发布 = Prompt + 模型 + 检索参数 + 知识库快照，整体版本化可回滚」通过版本表落地；「新建配置版本前必须过 Eval 才能发布」这道质量门槛在评测系统（M11）缺位的情况下，本波用硬编码 stub 占位（schema 预留真实字段，未来无缝替换实现）。产品权威来源为 `RAG知识库问答系统设计/docs/Agent管理与检索测试-产品设计文档.md`「二、Agent 管理」整节与 `CodeCrushBot.dc.html` 对应原型区块。

## Boundaries

> 反漂移边界。任何实现若越过这些边界，应先回来改本文。

**In-scope**

- Agent 列表（绑定知识库/生成模型/派生 status/更新时间）、新建 Agent（五区块表单：基础信息/绑定知识库/模型设置/Prompt 配置/检索设置，落 `agents` + v1 `agent_config_versions`，v1 豁免 Eval 直接上线）。
- 编辑 Agent：**仅** `name`/`desc`/`enabled` 可改（契约层 `strictObject` 拒绝其他键 + service 层显式校验双重防线，复用 `knowledge-bases` 模块对 `embeddingModelId` 锁定的既有模式）。
- 配置版本抽屉：查看历史版本列表（版本号/status/eval_status/发布人时间/四项关键配置摘要/变更说明）、新建配置版本（可重新绑定知识库、改模型/Prompt/检索参数）、Eval stub 确认、通过并发布、回滚到指定 archived 版本。
- 知识库 Embedding 一致性约束：前端红色警示态交互 + 后端集合级校验双重把关（不依赖数组顺序，取 `kbIds[0]` 的 embedding 模型为基准文案，校验本身是「distinct(embeddingModelId) 个数必须为 1」的顺序无关判断）。
- 模型/Prompt 引用校验：`genModelId` 必须是 `type='llm' && enabled`，`rerankModelId`（若提供）必须是 `type='rerank' && enabled`，`lightModelId` 同 `genModelId`；4 个 `prompt_*_ver_id` 必须存在且所属 `prompt.node` 与字段对应节点一致。
- 「日志」入口：前端路由跳转 `/admin/traces?agentId=<id>`，Agent 模块本身不新增后端接口；本设计文档记录一条对 M8/M9 的强约束（见 Invariants）。
- 联动补丁（M7 触发、M6/M3 需要跟进）：`prompts.service.ts:delete()` 补 FK 违反捕获（`ON DELETE RESTRICT` 命中时转 409，而非裸 500）；`models.service.ts:remove()` 的错误文案从「仍被知识库引用」泛化为「仍被知识库或 Agent 配置引用」。

**Out-of-scope（本波明确不做，schema 不堵死）**

- 真实 Eval 执行引擎（跑退款场景回归集、算准确率/召回命中率）——M11 里程碑2 首期不做；本波 `eval-run` 是硬编码 stub，永远返回 `passed`。
- `RetrieverPort` 真实检索管道内部实现（向量召回/关键词召回/融合/重排）——M5 范围，本设计只消费其既有契约形状（`agents`/`agent_config_versions` 的检索参数字段与其对齐），不涉及。
- Agent 删除（原型无入口，同 007 对 KB 删除的处理，API 不留）。
- `agent_kbs`「当前生效」镜像表（写时同步）——统一走 `agents.current_version_id → agent_config_version_kbs` 两跳 join，避免双写漂移；如未来 M8 热路径证明需要，再加。
- Trace 列表按 Agent 过滤的具体实现——M9 范围，本设计只定调过滤键必须是 `agentId`（稳定主键）而非 `agentName`（可编辑，见 Invariants）。
- RBAC／多角色（承接 001 既定：本期单角色 admin，任何合法 JWT 可调用全部 Agent 管理接口）。

**Invariants**

1. **配置版本一旦创建，`gen_model_id`/`rerank_model_id`/`light_model_id`/`prompt_*_ver_id`/`node_params`/检索参数/知识库快照集合不可变**——要改必须「新建配置版本」产生新的一行，不允许 UPDATE 已有 `agent_config_versions` 行的业务字段（`eval_*`/`published_*` 等状态流转字段除外）。
2. **发布（`publish`/`rollback`）前必须 `eval_status ∈ {'passed','exempt'}`**，否则 409。v1 恒为 `exempt`；`rollback` 目标版本历史上已经过这道门槛，不重新校验。
3. **模型/Prompt 版本内容不深拷贝进 `agent_config_versions`**——引用 FK 直连 `model_providers`/`prompt_versions`，历史版本展示「跟随」这些实体的当前内容（`prompt_versions.body` 本身不可变，`model_providers` 的 `base_url`/`params` 可能被 M3 的 PATCH 修改，历史 Agent 版本会实时反映）。这是刻意的一致性选择，不是遗漏。
4. **Trace 按 Agent 过滤必须用 `agent_id`（稳定主键），不得用 `agent_name`**——因为「编辑」入口允许自由改名，M8 打点/M9 筛选若用名字，改名后会漏掉历史 trace。此约束现在写入本文档，供 M8/M9 设计时遵守。
5. **知识库绑定的 embedding 一致性校验必须在后端重复执行**，不得只依赖前端红色警示态（无 RBAC 场景下任何持 token 调用方可绕过前端）。

## Context

产品权威来源同 007：原型目录《RAG知识库问答系统设计/》最新版（`CodeCrushBot.dc.html` 与 `docs/Agent管理与检索测试-产品设计文档.md`）。M6（Prompt 管理，版本/diff/发布/回滚）已完整实现并验证过「版本化 + 单一 promote() 入口」范式，是本设计的直接参照模板。M4（知识库）已验证过「强约束用契约层 `strictObject` + service 层显式校验双重防线」的模式（`embeddingModelId` 创建后锁定），本设计的「编辑」字段收窄直接复刻该模式。

产品文档存在两处需要工程判断裁决的歧义，已通过用户拍板解决：

- 「配置版本」是否包含知识库快照 vs 「编辑」入口字面上「复用新建 Agent 表单」（暗示全字段可写）——两者字面冲突，拍板结果：知识库随版本可改绑，编辑收窄为基础信息。
- 「必须先跑 Eval 并通过」在评测系统（M11）缺位下如何落地——拍板结果：本波硬编码 stub，字段预留，M11 落地后原地替换实现。

## Goals / Non-goals

**Goals**：建 Agent 绑齐知识库/三类模型/4 个 Prompt/检索参数、保存生效（对齐路线图 M7 验收标准）；配置版本可发布可回滚，回滚后生产配置立即整体切回；Eval 门槛的产品叙事（按钮存在、状态可见）保留，即使背后是 stub。

**Non-goals**：见 Boundaries Out-of-scope。不做真实评测、不做检索管道、不做 RBAC。

## Design

### 数据模型

```
agents
  id                  uuid PK
  name                text NOT NULL UNIQUE
  desc                text NOT NULL DEFAULT ''
  enabled             boolean NOT NULL DEFAULT true
  current_version_id  uuid NULL REFERENCES agent_config_versions(id)
                        -- 循环 FK：无 DB 层即时约束，靠 service 写入顺序保证
                        -- （先插 agents(current_version_id=null) → 插 v1 → 回填指针），
                        -- 完全复刻 prompts.currentVersionId 的既有写法
  created_at          timestamp NOT NULL DEFAULT now()
  updated_at          timestamp NOT NULL DEFAULT now()
  updated_by          text NOT NULL

-- status 不落库，service 层 toAgent() 派生（同 prompts 模块 toPrompt() 的做法）：
--   currentVersionId === null → "draft"
--   enabled → "active"，否则 → "archived"

agent_config_versions
  id                      uuid PK
  agent_id                uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE
  version                 integer NOT NULL          -- 每 agent 从 1 递增，unique 撞号重试（同 prompts 模式）
  status                  text NOT NULL DEFAULT 'draft'   -- draft | published | archived
  gen_model_id            uuid NOT NULL REFERENCES model_providers(id) ON DELETE RESTRICT
  light_model_id          uuid NULL REFERENCES model_providers(id) ON DELETE RESTRICT
  rerank_model_id         uuid NULL REFERENCES model_providers(id) ON DELETE RESTRICT
  prompt_rewrite_ver_id   uuid NOT NULL REFERENCES prompt_versions(id) ON DELETE RESTRICT
  prompt_intent_ver_id    uuid NOT NULL REFERENCES prompt_versions(id) ON DELETE RESTRICT
  prompt_reply_ver_id     uuid NOT NULL REFERENCES prompt_versions(id) ON DELETE RESTRICT
  prompt_fallback_ver_id  uuid NOT NULL REFERENCES prompt_versions(id) ON DELETE RESTRICT
  node_params             jsonb NOT NULL DEFAULT '{}'   -- 4 节点各自 {freedom, temperatureEnabled, temperature, topPEnabled, topP}
  top_k                   integer NOT NULL
  top_n                   integer NOT NULL
  threshold               real NOT NULL
  multi_recall            boolean NOT NULL DEFAULT true
  vec_weight              real NULL
  fallback_human          boolean NOT NULL DEFAULT true
  eval_status             text NOT NULL DEFAULT 'not_run'  -- not_run | passed | exempt（M7 阶段不产生 failed/running）
  eval_run_at             timestamp NULL
  eval_pass_rate          real NULL              -- M7 阶段恒 null（stub 不编造数字），M11 接入后写真实值
  eval_summary            jsonb NULL             -- M7: {stub:true,message:'M11 评测系统上线前占位，默认标记通过'}；M11 后存真实指标
  note                    text NULL              -- 变更说明
  created_by              text NOT NULL
  created_at              timestamp NOT NULL DEFAULT now()
  published_by            text NULL
  published_at            timestamp NULL

  UNIQUE (agent_id, version)
  INDEX (agent_id, status)
  INDEX (agent_id, created_at DESC)

agent_config_version_kbs
  version_id   uuid NOT NULL REFERENCES agent_config_versions(id) ON DELETE CASCADE
  kb_id        uuid NOT NULL REFERENCES knowledge_bases(id) ON DELETE RESTRICT
  PRIMARY KEY (version_id, kb_id)
  INDEX (kb_id)
```

此表结构修订 `docs/design/001-rag-platform-architecture.md` 数据模型章节里原先扁平的 `agents(...)` 单表草案与 `agent_kbs(agent_id, kb_id)`，理由同 007 修订 001 的先例：早期草图先于版本化细节设计画出，深化后回填修订。

### API 端点

| 操作 | 方法 & 路径 | 说明 |
|---|---|---|
| 列表 | `GET /api/agents` | 不分页（对齐 knowledge-bases 量级假设），后端 join 聚合返回 kb 名称/模型名称/派生 status |
| 详情 | `GET /api/agents/:id` | 基础信息 + 当前生产版本完整配置展开 |
| 新建 | `POST /api/agents` | 建 `agents` + v1 `agent_config_versions`（`eval_status='exempt'`，直接 `published`）单事务 |
| 编辑基础信息 | `PATCH /api/agents/:id` | `{name?, desc?, enabled?}`，`strictObject` 拒绝其他键 |
| 配置版本列表 | `GET /api/agents/:id/config-versions` | 按 `created_at DESC` |
| 新建配置版本 | `POST /api/agents/:id/config-versions` | 建 draft 行，`eval_status='not_run'`；可携带新的 `kbIds` |
| 跑 Eval（stub） | `POST /api/agents/:id/config-versions/:versionId/eval-run` | 硬编码 stub：立即置 `eval_status='passed'`、`eval_run_at=now()`、`eval_summary={stub:true,...}`；不需要请求体 |
| 发布 | `POST /api/agents/:id/config-versions/:versionId/publish` | 校验 `eval_status∈{passed,exempt}` 否则 409；`promote()`：旧 prod→archived，该版本→published，`agents.current_version_id` 回写 |
| 回滚 | `POST /api/agents/:id/config-versions/:versionId/rollback` | 校验目标 `status='archived'`；同一 `promote()` 入口 |

无 `DELETE /api/agents/:id`。

### 数据流程图：新建 Agent → 新建配置版本（Eval stub）→ 发布 → 回滚

```
①「新建 Agent」抽屉                              AgentsService.create() ——单事务——
 {name,desc,kbIds[],genModelId,                 ┌─────────────────────────────────────┐
  promptRewrite/Intent/Reply/FallbackVerId,      │ a) INSERT agents                     │  → agents 表
  nodeParams,topK,topN,threshold,                │    (current_version_id=NULL)          │
  multiRecall,vecWeight,fallbackHuman}   ───────▶│ b) 校验：KB embedding一致(集合级) /    │
                                                  │    模型type+enabled / prompt归属node   │
                                                  │ c) INSERT agent_config_versions v1    │  → agent_config_versions 表
                                                  │    status='published'                │     (eval_status='exempt')
                                                  │    eval_status='exempt' ←v1豁免Eval   │
                                                  │ d) INSERT agent_config_version_kbs    │  → agent_config_version_kbs 表
                                                  │ e) UPDATE agents.current_version_id=v1│  → agents 表回写
                                                  └─────────────────────────────────────┘
                                                       Agent 即刻上线（v1 生产）

②「新建配置版本」抽屉（可改绑知识库）             createVersion()
 {同上字段，可换 kbIds/模型/Prompt/检索参数,     ───▶ INSERT agent_config_versions v2         → agent_config_versions 表
  note}                                              status='draft', eval_status='not_run'   （新增一行，不动 agents）
                                                      [INSERT agent_config_version_kbs(v2,…)] → agent_config_version_kbs 表
                                                                  │
                                                                  ▼
                                    ┌──────────────────────────────────────────────┐
                                    │ 「跑 Eval」按钮 → POST .../v2/eval-run          │  → agent_config_versions 表
                                    │ 硬编码 stub：无需请求体，立即                    │     （原地 UPDATE 该行）
                                    │ UPDATE eval_status='passed', eval_run_at=now(), │
                                    │        eval_summary={stub:true,message:'M11    │
                                    │        评测系统上线前占位，默认标记通过'}         │
                                    └──────────────────────────────────────────────┘
                                                                  │
③「通过并发布」按钮                                                ▼
 POST .../v2/publish ──校验 eval_status∈{passed,exempt}──▶ promote() ——单事务——
   否则 409「未通过 Eval 门槛」                    ┌─────────────────────────────────────┐
                                                  │ a) UPDATE 旧prod(v1) status='archived'│  → agent_config_versions 表
                                                  │ b) UPDATE v2 status='published',       │     （两行 UPDATE）
                                                  │    published_by, published_at         │
                                                  │ c) UPDATE agents.current_version_id=v2 │  → agents 表
                                                  └─────────────────────────────────────┘
                                                       v2 成为生产版本，v1 转 archived

④「回滚到此版本」（仅 archived 版本可点）
 POST .../v1/rollback ──校验 v1.status='archived'──▶ 同一 promote() 入口（v1 历史上已过门槛，
                                                        eval_status 早为 passed/exempt，不重跑）
                                                  UPDATE v2→archived, v1→published,
                                                  agents.current_version_id=v1
```

### 知识库 Embedding 一致性后端校验

不照抄前端「取第一个选中项做基准逐个比较」的 UI 状态机写法，用顺序无关的集合判断：

```
1. kbIds 长度 ≥ 1，否则 400
2. 批量查 knowledge_bases WHERE id IN (kbIds)：任一不存在 → 404
3. distinct(embeddingModelId) 个数 > 1 → 400
   文案："「{冲突KB名}」使用 {冲突KB的embedding模型名}，与已选知识库的向量模型
         （{kbIds[0]对应的embedding模型名}）不一致，无法同时绑定"
   （基准取 kbIds[0] 仅用于错误文案措辞对齐前端展示逻辑，校验本身是集合判断，不依赖顺序）
```

不额外校验 KB 的 `status`（building/failed 均可绑定，007 未定义「仅 ready 可绑定」这条不变量，检索侧恒读 `active_version` 不受影响）。

### 联动补丁（本波必须跟进的 M6/M3 既有代码缺口）

1. `apps/backend/src/modules/prompts/prompts.service.ts:delete()`：当前只检查 `currentVersionId === null` 就允许删除并级联删 `prompt_versions`。M7 后，某个从未发布过的 Prompt 名下的 draft 版本可能已被 `agent_config_versions`（哪怕草稿态）引用，`ON DELETE RESTRICT` 会抛 `23503` 但当前无 catch，会 500 甩给前端。修法：照抄 `models.service.ts:remove()` 的 `catch(isForeignKeyViolation) → ConflictException` 模式补上。
2. `apps/backend/src/modules/models/models.service.ts:remove()`：错误文案硬编码「model {id} 仍被知识库引用，无法删除」，M7 后模型也可能被 `agent_config_versions` 引用触发同一分支，需泛化为「仍被知识库或 Agent 配置引用，无法删除」。

## Trade-offs

| 决策 | 选择 | 拒绝的备选 | 理由 |
|---|---|---|---|
| 版本化建模 | `agents`(指针) + `agent_config_versions`(快照) 两表分离 | 001 原草案扁平单表 `agents` | 发布=整体快照回滚是核心产品语义，需要真正的版本行而非增量日志重放 |
| 知识库快照存储 | `agent_config_version_kbs` 版本级快照表 | `agent_kbs(agent_id,kb_id)` 写时同步镜像表 | 镜像表需要在每次发布/回滚时同步维护，引入「事务漏更镜像表」的漂移风险；两跳 join 在管理台低 QPS 下开销可忽略 |
| 版本快照内容 | FK 直引用 `model_providers`/`prompt_versions`，不深拷贝 | 深拷贝模型参数/Prompt 正文进版本表 | `prompt_versions.body` 本身不可变，FK 已具备历史准确语义；`model_providers` 允许「跟随当前配置」是刻意的一致性选择，深拷贝的运维/一致性成本远超收益 |
| Eval 门槛落地 | 硬编码 stub（`eval-run` 恒返回 passed），字段预留 | (a) 人工必填理由确认 (b) 原型字面固定假百分比 | 用户拍板：「先写死，等 M11 再实现」——优先克制本波工程投入，接受质量闭环暂时是形式而非实质，待评测系统落地后原地替换 |
| 编辑入口范围 | 收窄为 `name`/`desc`/`enabled` | 全字段原地可写（复用新建表单字面含义） | 全字段可写会让运营绕开「新建配置版本 + Eval 门槛」直接改生产参数，质量闭环形同虚设；原型「编辑」按钮本身未接 onClick，印证是有意留白 |
| v1 首个版本 | 豁免 Eval（`eval_status='exempt'`） | 强制走一次确认流程 | 无生产基线可比较，门槛判定动作本身无意义；用户拍板确认 |
| Trace 过滤键 | 预留给 M8/M9：`agentId` | `agentName` | 「编辑」允许改名后，用名字过滤会在改名后漏掉历史 trace 数据 |

## Assumptions

1. `RetrieverPort`（M5）契约后续会与本设计的检索参数字段集（topK/topN/threshold/multi/vecWeight/rerankModelId）对齐，不发生破坏性变更。
2. 管理台无 RBAC（001 既定），任何合法 JWT 可调用全部 Agent 管理接口；`GET /agents` 不分页（假设 Agent 数量级与知识库同一量级，不会膨胀到需要分页）。
3. `model_providers`/`prompt_versions` 内容变更后，历史 `agent_config_versions` 的展示会「跟随」当前内容而非固化快照——这是刻意选择，不是遗漏。
4. Eval stub 阶段（`eval-run`）不产生任何真实回归测试执行，纯粹是发布流程状态机的占位开关。

## Revisit Triggers

1. **M11 评测系统落地时**：`eval-run` 需要从硬编码 stub 换成真实调用退款场景回归集，写入真实 `eval_pass_rate`/`eval_summary`；届时重新评估是否需要人工兜底确认通道（评测系统故障时的应急覆盖）。
2. **Agent 规模显著超出「管理台量级」假设时**：重新评估 `GET /agents` 是否需要分页、`agent_config_version_kbs` 两跳 join 是否需要退化为镜像表。
3. **若发现「模型/Prompt 变更后历史版本展示跟随当前值」造成审计/回溯问题**：需要改为深拷贝快照，涉及 schema 变更。
4. **M8/M9 落地埋点时**：需确认 trace span 的 `agent_id` 属性具体打点方式，与本设计 Invariant 4（trace 过滤键用 agentId）对齐，避免二次返工。

## References

- `docs/design/001-rag-platform-architecture.md`（整体架构，本文档修订其 `agents`/`agent_kbs` 数据模型草案）
- `docs/design/002-implementation-roadmap.md`（路线图，M7 依赖 M3/M4/M5/M6）
- `docs/design/007-m4-ingestion-pipeline.md`（文档结构与「回填修订上游草案」先例参照）
- `apps/backend/src/modules/prompts/`（版本化 + `promote()` 范式来源）
- `apps/backend/src/modules/knowledge-bases/`（「创建后锁定」双重校验模式来源）
- `RAG知识库问答系统设计/docs/Agent管理与检索测试-产品设计文档.md`（产品权威来源）
