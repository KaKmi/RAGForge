---
title: "Prompt 管理模块重构"
description: "Prompt 版本从三态状态机改为可排他移动的标识（标签）模型，详情页新增试运行，谁在用改为应用域只读派生视图。"
category: "design"
number: "012"
status: current
services: [backend, frontend, contracts]
related: ["design/001", "design/002", "design/003", "design/009", "design/011"]
last_modified: "2026-07-11"
---

# 012 — Prompt 管理模块重构

## Status

`current` — 本文经 `/ship:arch-design` 完成需求梳理、高层设计、关键点深钻、规模评估与权衡分析五阶段自审（数据模型变更走深，观测/安全走简），并已实现落地：`packages/contracts/src/node-contract.ts`（静态字段契约与 `compilePromptBody()`）、`apps/backend/src/modules/prompts/`（迁移 `0011_pink_falcon.sql` 加法 + `0012_charming_sphinx.sql` 破坏性清理、`prompt_version_tags` 排他标签、try-run 端点）、`apps/frontend/src/pages/admin/PromptsPage.tsx` + `PromptDetailPage.tsx`（列表 + 路由式 Playground + 历史抽屉）。经 dev/review/QA 三阶段校验（含真实模型 key 下 reply/fallback try-run 成功路径的人工验收）。009 依赖的“谁在用”跨域端点未随本文交付，属已声明的 out-of-scope，留给 009/M7a。

本文替代两份此前存在、现已被用户删除且从未提交入库的草稿：`docs/design/proposals/prompt-management-redesign.md`（产品设计输入）与旧的 `011-prompt-assembly-node-contracts.md`（NodeContract 技术设计）。这两份文档的历史内容不再作为权威来源；本文重新收口其中「Prompt 管理」的那一半。NodeContract 执行引擎那一半已由 [011-prompt-assembly-node-contracts](011-prompt-assembly-node-contracts.md) 补齐，本文与之衔接。

本文最初写作时编号为 009，随后 M7 的《应用管理与配置发布》设计（原 Agent 管理）占用了 009 这个编号并将 `008-m7-agent-management.md` 一并重命名/替换，本文因此改为 012；文中所有对"Agent"域的引用同步改为"应用"（`applications`）域术语。2026-07-11 根据应用聚焦原型再次对齐 009：应用使用单一 production 指针和异步真实 ReleaseCheck，不复用 Prompt 标签模型。

M6（Prompt 管理）当前**已有真实实现并已合入主干**：`apps/backend/src/modules/prompts/`、迁移文件 `0002_vengeful_chronomancer.sql`。M7 的实现代码仍是旧的 `apps/backend/src/modules/agents/`（`agent_config_versions` 三态状态机 + Eval stub），尚未按 009 迁移到 `applications`；因此本文不是从零设计，而是对**已上线 schema 与状态机**的破坏性重构，Rollout 章节按此谨慎给出分步迁移路径。

## Summary

Prompt 管理从「`draft/prod/archived` 三态状态机 + `prompts.current_version_id` 单一指针」改为「版本平权（只按版本号递增排序，无状态字段）+ 可在版本间排他移动的自定义标识（标签）」，交互模型对齐 git tag / MLflow alias。`production` 只是 Prompt 域内的强调色标签，移动它**不触发任何门禁，也不改变任何线上应用**。应用发布使用 009 定义的单一 `applications.production_config_version_id`，应用版本固定引用具体 PromptVersion；两个域不共享标签模型。

Prompt 页面不做「绑定应用」管理功能，但版本粒度提供一个只读、动态计算的「谁在用」信号（如"● v7 服务中"徽标 + 具名条幅"「售后支持」的线上配置正用着 v7"）。这与已删除的旧产品提案的"Prompt 完全不提 Agent"铁律相冲突——新原型明确要求展示。本文的解法是把这个只读派生视图的**计算权和查询端点**放在 `applications` 域（它本来就持有指向 `prompt_versions` 的 FK），Prompt 前端页面跨域调用 `applications` 暴露的只读端点，从而在满足产品需求的同时不引入 `prompts → applications` 的反向后端依赖，`prompts` 继续保持 003 定义的叶子模块地位。

详情页从已删除旧提案设想的静态四栏（编辑/常用配置/预览调试/版本记录）简化为「编辑 + 试运行」两栏 + 一个历史版本抽屉；「常用配置」被折进试运行区（参照某个应用带出测试参数），「版本记录」从常驻第四栏改为按需展开的抽屉。试运行是本次新增的产品缺口修补——此前编辑 Prompt 后唯一的验证手段是发布后到 C 端问一遍。

由于 M8.0 的 `node-runtime`（NodeContract 执行引擎）在本文写作时连目录都不存在（`chat.service.ts` 仍是 M2 硬编码桩代码），而新版 Prompt 详情页的编译错误提示、可插入字段、试运行结构化校验都依赖 NodeContract 的字段定义，本文把 NodeContract 拆成两层：

- **静态字段契约**——四个固定节点的输入/保留字段名表 + 编译规则（`compilePromptBody()`），是纯函数，无模型调用、无 IO，可以前置进前后端共享的纯逻辑包，随 M6 独立交付，不等待 node-runtime 后端模块。
- **执行契约**——结构化输出协议适配、Schema/动态值域校验、修复重试、Fallback、应用发布门禁预演，属于 M8.0 `node-runtime` 域，已由 [011-prompt-assembly-node-contracts](011-prompt-assembly-node-contracts.md) 独立设计。

这一分层让 Prompt 管理不必等待整个 NodeContract 引擎落地即可交付版本/标签/编译提示/部分试运行能力，同时不违反 002 路线图「M6 只依赖 M2」的既定排序。

## Boundaries

> 反漂移边界。任何实现若越过以下范围，应先回来改本文，而不是让代码与设计各说各话。

**In-scope**

- `prompts`/`prompt_versions` 表结构变更：去掉 `status` 三态字段与 `prompts.current_version_id` 指针；`prompt_versions` 新增 `contract_version`（延续 001/003 已确立的不变量：PromptVersion 固定 ContractVersion，见 011）、`compile_status`/`compile_errors`；新增 `prompt_version_tags` 表实现排他标签。
- Prompt 列表页 / 详情页（编辑 + 试运行两栏）/ 历史版本抽屉 / 新建 Prompt 弹窗的信息架构、状态流转与组件契约，对齐最新原型 `RAG知识库问答系统设计/CodeCrushBot.dc.html`（不是仓库根目录同名旧文件，也不是 `-改版前备份`/`-print` 等旁支副本）。
- 标签排他移动机制：数据结构、原子移动实现（`UNIQUE(prompt_id, tag_name)` + upsert）、`production` 二次确认交互（Prompt 侧是纯提示性确认，不同于应用侧会触发门禁的确认）、自定义标签命名校验规则。
- 「谁在用」只读派生视图的 API 归属设计（落在 `applications` 域，Prompt 前端跨域调用）与查询形状。
- NodeContract 的「静态字段契约」部分（四节点固定 input/reserved 字段名表、`compilePromptBody()` 编译规则）的包边界与前后端共享方式，作为 M6 可独立交付的前置依赖；执行契约见 011。
- 试运行功能按节点分阶段的能力契约：M6 阶段 reply/fallback 直连 `ModelProviderPort.chat()` 可用，rewrite/intent 返回明确的「待 M8.0」占位，而不是伪造结构化结果——011 落地后升级为真实实现。
- 应用侧 Prompt 版本下拉候选范围放开（不再过滤"已发布"，改为该节点下全部版本，带标识排前）——只描述这一个对 `applications` 模块的影响面，不重新设计应用管理本身（见 009）。

**Out-of-scope（明确交给其他文档）**

- NodeContract 的「执行契约」完整技术设计——已由 [011-prompt-assembly-node-contracts](011-prompt-assembly-node-contracts.md) 覆盖，本文只定义 Prompt 侧对它的接口期望。
- 应用（原 Agent）的 production 指针、ReleaseCheck、数据模型与详情页 IA——已由 [009-m7-application-management](009-m7-application-management.md) 覆盖。应用不复用 Prompt 排他标签模型。
- Prompt 对应用的任何反向管理能力（增删绑定关系）——不做，只做只读派生展示。
- "✦ AI 优化"功能的实现方式——原型里是本地正则清理（去重复行、去重复字段 token、修花括号配对），不是真调 LLM；本文记录这一现状供实现阶段参考，不承诺是否升级为真模型调用。
- Trace 导入试运行输入框的功能——依赖既有 M9 Trace 模块的只读能力，不改变 Trace 模块设计。

**Invariants（不可违反的不变量）**

1. **Prompt 标签移动永不触发门禁/预演/发布语义**：包括 `production`。唯一决定“对外服务什么”的事实是应用的 `production_config_version_id`（009）。
2. **`prompts` 模块保持叶子**：不 import `applications`；「谁在用」由 `applications` 域计算并对外暴露只读端点，Prompt 前端跨域调用它，不产生后端反向依赖。
3. **Prompt 版本不可变**：保存产生新版本，不原地改写已存在版本的 body；标签的版本归属可以移动，但移动的是标签行的指向，不是改写版本内容本身。
4. **预览等于运行时**：试运行（预览）与真实运行必须共用同一套字段契约/组装/校验实现，不允许 Prompt 页面自造一套轻量渲染——即使 M6 阶段 rewrite/intent 试运行尚未开放，也不能用假数据伪装成真实校验结果，必须显式返回"暂不可用"。
5. **标签排他性由数据库唯一约束保证并发安全**，不依赖应用层"先查后写"的协调。

## Context

现有代码已经实现了 M6/M7 的三态状态机版本：

- `apps/backend/src/modules/prompts/`：`prompts(id, name unique, node, current_version_id nullable, updated_by, created_at, updated_at)`；`prompt_versions(id, prompt_id, version, body, variables jsonb, note, author, status default 'draft', created_at)`，唯一索引 `(prompt_id, version)`，索引 `(prompt_id, status)`。Service 提供 `createPrompt`/`createVersion`/`promote`（发布/回滚合一入口，draft→prod 或 archived→prod，已 prod 则 409）/`delete`（仅未发布草稿可删）。
- `apps/backend/src/modules/agents/`：`agent_config_versions` 同款 `status`（draft/published/archived）三态 + `eval_status`（not_run/passed/exempt，M7 阶段 stub）双状态机；四个 `prompt_*_ver_id` FK（`ON DELETE RESTRICT`）指向 `prompt_versions`。这是**尚未迁移的旧代码**——[009-m7-application-management](009-m7-application-management.md) 的目标模型改为不可变版本 + `applications.production_config_version_id` + 异步真实 ReleaseCheck，完全去掉 Eval stub。本文的「谁在用」查询和应用侧下拉按目标模型描述。
- `node-runtime` 模块目录不存在；`chat.service.ts` 明确注释为 M2 桩代码，`generateStream()` 返回硬编码 mock 事件；[011-prompt-assembly-node-contracts](011-prompt-assembly-node-contracts.md) 已给出该域的完整设计。
- `packages/contracts/src/prompts.ts` 定义 `PromptVersionStatusSchema = z.enum(["draft","prod","archived"])`；`prompt-template.ts` 已有 `extractVars`/`renderTemplate`/`diffPromptBodies` 纯函数，与本文新增的 `compilePromptBody()` 属于同一类"前后端必须一致的纯逻辑"，适合并列在同一个包里。

## Goals / Non-goals

**Goals**

- 消除「发布 = 让所有引用它的应用立刻变化」的产品语义误解——改为版本平权 + 标签记账，Prompt 侧的任何标签操作对已上线应用零影响。
- 让 Prompt 编辑后能立刻试运行验证效果，不必发布到 C 端才能看到。
- 在 `node-runtime` 尚未落地时，Prompt 管理仍可独立交付，不被 M8.0 阻塞。
- 「谁在用」信息可见，但不引入模块间反向依赖或缓存一致性负担。

**Non-goals**

- 不做标签权限管控（任何操作者可自由创建/移动任意标签）。
- 不做多人协同编辑锁。
- 不做 Prompt 到应用的任何反向管理界面。
- 不追求 rewrite/intent 结构化试运行在 M6 阶段就绪——这是 011/M8.0 的产出。

## Requirements & 关键数字

| 维度                 |                                                                                                                          量级 | 影响                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------: | --------------------------------------------------- |
| Prompt 数            |                                                                                                                        数十个 | 列表页无需分页优化                                  |
| 每 Prompt 版本数     |                                                                                                              个位数～二十左右 | 历史抽屉默认展开 3 条 + "展开更早"够用              |
| 应用数               |                                                                                                  数十个至百个（009 假设 100） | 「谁在用」查询命中集合小                            |
| 每版本标签数         |                                                                                                                        1–3 个 | UI 徽标横排即可，不需要折叠                         |
| 「谁在用」查询复杂度 | `applications.production_config_version_id` join 数千行量级的 `application_config_versions`，再匹配四个 `prompt_*_version_id` | 不需要缓存/物化视图，见 Revisit triggers 的重估阈值 |
| 试运行延迟           |                                                                                        同步等待模型响应，复用 M3 既有超时设置 | 无需新增 SLA                                        |

## Design

### 1. 数据模型

```text
prompts
  id            uuid PK
  name          text NOT NULL UNIQUE
  node          text NOT NULL   -- rewrite | intent | reply | fallback
  updated_by    text NOT NULL
  created_at    timestamptz NOT NULL DEFAULT now()
  updated_at    timestamptz NOT NULL DEFAULT now()
  -- 删除：current_version_id（不再有"当前生产版本"指针；"最新版本"改为
  --   ORDER BY version DESC LIMIT 1 实时算出，"服务中版本"是跨域派生视图，不是本表字段）

prompt_versions
  id                uuid PK
  prompt_id         uuid NOT NULL REFERENCES prompts(id) ON DELETE CASCADE
  version           int NOT NULL
  body              text NOT NULL
  variables         jsonb NOT NULL            -- 保留：extractVars(body) 抽取结果，供列表"变量"列展示
  contract_version  int NOT NULL DEFAULT 1     -- 新增：延续 001/011 不变量，运行时按此版本解析 NodeContract
  compile_status    text                       -- 新增：ok | has_errors | has_warnings（服务端保存时用 §5 的 compilePromptBody() 算出）
  compile_errors    jsonb                      -- 新增：CompileResult.errors，供历史版本回看/应用发布门禁复用
  note              text
  author            text NOT NULL
  created_at        timestamptz NOT NULL DEFAULT now()
  -- 删除：status（三态状态机整体去掉）
  UNIQUE (prompt_id, version)

prompt_version_tags                            -- 新增
  id                 uuid PK
  prompt_id          uuid NOT NULL REFERENCES prompts(id) ON DELETE CASCADE          -- 冗余列，见下
  prompt_version_id  uuid NOT NULL REFERENCES prompt_versions(id) ON DELETE CASCADE
  name               text NOT NULL             -- production 或任意自定义标签
  created_at         timestamptz NOT NULL DEFAULT now()
  created_by         text NOT NULL
  UNIQUE (prompt_id, name)                     -- 排他性的落点：同一 Prompt 下同名标签全局唯一（跨版本）
```

`prompt_id` 在 `prompt_version_tags` 里是冗余列（从 `prompt_versions.prompt_id` 拷贝而来），但这是必须的冗余：Postgres 的 `UNIQUE` 约束只能建在本表列上，要在“同一 Prompt 下同名标签唯一”这个跨版本约束上拿到数据库级排他保证，`prompt_id` 必须出现在标签表里。该标签模型只属于 prompts；009 的应用发布采用 production 指针，不建立对应标签表。

**移动标签是一条原子语句**：

```sql
INSERT INTO prompt_version_tags (prompt_id, prompt_version_id, name, created_by)
VALUES ($promptId, $newVersionId, $tagName, $user)
ON CONFLICT (prompt_id, name)
DO UPDATE SET prompt_version_id = excluded.prompt_version_id,
              created_at = now(),
              created_by = excluded.created_by;
```

这比"先 `DELETE` 旧行、再 `INSERT` 新行"的应用层两步协调更安全：两个并发的移动请求会在这条 `UPSERT` 语句上天然串行——数据库行锁保证第二个请求要么看到第一个请求已提交的新指向并在其基础上再次移动，要么等待并覆盖，不会出现"同名标签短暂同时指向两个版本"或者"两次移动互相打断导致标签丢失"的竞态。这是 Invariant 5 的具体实现。

摘除标签是一条 `DELETE FROM prompt_version_tags WHERE prompt_id=$1 AND name=$2`。

列表页「最新版本」列 = `SELECT * FROM prompt_versions WHERE prompt_id=$1 ORDER BY version DESC LIMIT 1`；「标识」列 = 该最新版本 `LEFT JOIN prompt_version_tags`。两者都是实时查询，不依赖任何持久化指针。

### 2. 信息架构

**列表页**（沿用路由 `/admin/prompts`）：名称 / 所属节点 / 最新版本 / 标识 / 变量 / 更新人·时间。点行进入路由式详情页（`/admin/prompts/:id`），不是抽屉。

**详情页头部**：返回 / 面包屑 / Prompt 名 / 节点标签 / 「谁在用」徽标（仅当前编辑版本被至少一个应用的 production 配置引用时展示，如"● v7 服务中"）/ 历史版本按钮（带版本总数）。

**左栏 · 编辑区**：

- 只读的「这个节点是做什么的」说明（平台侧文案，人话版，不是发给模型的 System 指令）。
- 「你希望它怎么做」——管理员 Instructions 的 `textarea`，这是 Prompt 正文的全部内容。
- 编译错误行（红色，来自 §5 的 `compilePromptBody()`，部分错误带"一键改为…"修复建议）。
- 编译警告行（黄色，软提示，如"疑似重复粘贴"，附"一键优化"入口）。
- 可插入字段 chips（来自该节点的静态字段契约 `inputs` 列表，点击插入 `{fieldName}` 占位符；文案强调"不插入也会正常提供给它"）。
- 底部提交栏：版本说明输入框 + "保存为新版本"按钮。

**右栏 · 试运行区**：

- 生成参数：参照某个应用带出（可覆盖，仅影响本次测试，不影响任何正式配置）、测试模型、温度。
- 输入数据：用户问题、历史对话（可空）、检索到的内容（仅 reply 节点需要，明确标注"回复的依据，别手编"）；支持从 Trace 导入。
- 运行按钮 + 结果区：rewrite/intent 展示结构化字段 + 校验步骤图标（§6 定义 M6/M8.0 两阶段行为）；reply/fallback 展示纯文本。

**服务中条幅**：当前编辑版本被生产引用时，详情页底部展示具名条幅，例如：「"售后支持"的线上配置正用着 v7，对外服务中。改这个版本不会影响正在服务的内容——改完保存会生成新版本；要让新内容生效，去对应应用的配置里把节点指向新版本并上线。」这条文案是消解"发布=上线"误解的关键产品语言，必须在实现时逐字对齐。

**历史版本抽屉**：版本列表，每条展示版本号 / 是否为当前编辑版本 / "服务中 · <应用名>"徽标（命中时）/ 说明 / 提交人时间 / "创建副本"操作。点击整行 = 载入编辑器（把该版本内容设为当前编辑内容，不产生新版本记录）；"创建副本"在此基础上额外预填版本说明为"基于 vX 修改"。

**新建 Prompt 弹窗**：名称 + 所属节点（四个固定节点单选）。创建后立即生成空 body 的 v1（无标签）并跳转进详情页编辑。

**关于"还原为此版本"**：原型代码里定义了一个 `revert(v)` 函数（把历史版本内容作为新版本重新提交，等价 git revert），但**没有绑定到任何 UI 元素**——当前渲染的历史抽屉只暴露"创建副本"一个入口。这与已删除的旧产品提案设想的"创建副本 vs 还原为此版本"两个语义不同的动作不一致，是产品侧在这一轮设计中做出的简化。本文按现状（单一入口）设计，不在真实实现里恢复"还原"作为独立按钮；`revert()` 对应的行为完全可以通过"创建副本→不改内容→直接保存"达成，没有必要维护两条代码路径。

### 3. 标签排他机制与 production 的特殊性

标签管理面板只属于 Prompt 域：列出该 Prompt 下所有已存在标签，勾选即把标签原子移动到当前 PromptVersion；目标标签指向其他版本时提示“当前指向 vX，勾选将移动到此版本”。

移动或摘除 Prompt 的 `production`（或任意标签）只触发提示性二次确认，文案必须明确“仅摘除/移动 Prompt 标签，不影响任何服务”，不做发布门禁、不调用预演。应用没有标签面板；应用上线由 009 的单一 production 指针与异步 ReleaseCheck 完成。

**自定义标签命名规则**：仅允许字母、数字、`.`、`_`、`-`；保留字 `v`（与版本号前缀视觉混淆）和 `production`（走专门勾选流程，不允许从“创建自定义标识”入口重复创建）禁止直接创建。

### 4. "谁在用"跨域只读视图

新增一个属于 `applications` 模块的只读端点：

```
GET /api/applications/prompt-usage?promptId=<uuid>
→ [{ promptVersionId, version, applicationId, applicationName }]
```

查询该 Prompt 名下所有版本，当前被哪些应用的生产配置引用：`applications.production_config_version_id` 连接 `application_config_versions`，再匹配四个 `prompt_*_version_id`。查询逻辑天然属于 `applications`——它本来就持有指向 `prompt_versions` 的四个 FK，`prompts` 域完全不需要知道这件事。

Prompt 前端（详情页头部徽标、服务中条幅、历史版本抽屉的"服务中"标记）直接调用这个 `applications` 域端点渲染，不经过 `prompts` 后端。这保持了 `applications → prompts` 的既有依赖方向不变——只是新增了一个查询方向的端点，没有产生 `prompts → applications` 的后端代码依赖，`prompts` 依然是 003 定义的无域依赖叶子模块。

**拒绝的备选方案**：在 `prompts` 表加一个 `used_by_application_ids` 缓存列，由应用配置变更时级联写入。拒绝理由——① 引入跨模块的缓存一致性负担，应用发布/回滚/删除都要记得级联更新 Prompt 表，这类"改 A 要记得改 B"的隐式耦合正是 003 用 lint 焊死依赖方向所要避免的；② 直接违反 003 里"`prompts` 是无域依赖叶子"的既有边界；③ 当前量级下一次索引查找的延迟可以忽略，没有必要为省一次查询引入预计算和一致性风险。

### 5. NodeContract 静态字段契约与 M6/M8.0 的分层落地

四个固定节点各自的可引用字段表（这是"字段名字表"，不含 `outputSchema`/`systemInstructions`/`extraValidate`/`fallback` 函数等执行期内容——那些属于 011 定义的 `node-runtime` 域）：

| 节点     | key        | 管理员可引用字段（`templateFields`）   | 保留字段（只读注入，不可引用） |
| -------- | ---------- | -------------------------------------- | ------------------------------ |
| 问题改写 | `rewrite`  | `query`、`history`                     | —                              |
| 意图识别 | `intent`   | `query`、`history`                     | `availableRoutes`              |
| 回复生成 | `reply`    | `query`、`history`、`retrievalContext` | `citations`                    |
| 兜底话术 | `fallback` | —（正文即最终返回的纯文本）            | —                              |

编辑期编译规则 `compilePromptBody(body, node): CompileResult`：

| 情形                                          | 错误码                            | 处理                                                     |
| --------------------------------------------- | --------------------------------- | -------------------------------------------------------- |
| 花括号不匹配 / 嵌套双花括号                   | `INVALID_TEMPLATE_SYNTAX`         | 阻断保存前标红，不带修复建议                             |
| 引用保留字段（如 `{availableRoutes}`）        | `RESERVED_FIELD`                  | 标红，说明该字段由平台只读注入                           |
| 引用了别的节点的字段                          | `FIELD_NOT_AVAILABLE_FOR_NODE`    | 标红，说明字段实际归属哪个节点                           |
| 引用未知字段                                  | `UNKNOWN_VARIABLE`                | 标红，若拼写接近某个合法字段则带"一键改为 `{x}`"修复建议 |
| 同一字段短距离内重复出现 ≥3 次 / 整行内容重复 | `MESSY_DUPLICATE`（警告，非错误） | 黄色软提示，指向"AI 优化"                                |
| 正文为空                                      | —                                 | 不阻断草稿保存，但"保存为新版本"前需要提示               |

草稿阶段所有错误都**允许保存**（避免用户改到一半无法保存），真正的生产阻断留给应用发布门禁去做（009 §「production 发布门禁」第 3 条"Prompt 已成功编译，无未知变量或保留字段冲突"直接消费本文的编译结果）。

**包边界**：`compilePromptBody()` 和四节点字段表是纯函数/纯数据，无 Node-only 依赖、无模型调用、无 IO，放进前后端共享的纯逻辑包（延续 003 已经点名的"高价值共享目标"落点，与既有 `packages/contracts/src/prompt-template.ts` 的 `extractVars`/`renderTemplate` 并列，可以是同一个包里的新文件 `node-contract.ts`，也可以独立成 `@codecrush/prompt-contract`）。前端编辑器直接本地调用做实时红线提示，不需要网络往返；后端在保存版本时调用同一份实现，把结果写入 `compile_status`/`compile_errors`。这是 Invariant 4"预览等于运行时"在编译校验这一层面的体现——即使模型执行层（node-runtime）还没做,字段校验层已经能做到前后端行为完全一致。011 的 `NodeContract.templateFields` 应直接复用本文这份字段表，不重复定义。

### 6. 试运行的分阶段能力契约

```
POST /api/prompts/:id/versions/:version/try-run
body: { modelId, temperature, testVars: { query, history?, retrievalContext? }, refApplicationId? }
```

**M6 阶段**：

- reply/fallback：走"平台固定极简 System + 管理员 body + JSON 化 runtime data"直接调用 `ModelProviderPort.chat()`（011 已设计该方法），返回 `{ mode: 'text', text }`。
- rewrite/intent：**返回 `{ mode: 'unavailable', reason: 'pending_node_runtime' }`**，前端据此展示"结构化预览暂不可用，等 M8.0 落地"，不伪造校验结果——这是 Invariant 4 的直接要求。

**011 落地后**：同一端点内部改为调用 011 定义的 `NodeRuntimeService.executeStructured()`/`streamText()`，四节点全部支持，响应扩展为 `{ mode: 'structured', fields, validateSteps, fallbackUsed }`。响应形状从一开始就设计成按 `mode` 判别的 tagged union（`text` / `unavailable` / `structured`），避免二次破坏性改动这个端点的返回类型。

### 7. REST 契约汇总

| 端点                                                 | 归属模块     | 说明                                                                                                                                                                            |
| ---------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/prompts`                                   | prompts      | 列表：所有 Prompt + 最新版本摘要 + 标识 + 变量                                                                                                                                  |
| `POST /api/prompts`                                  | prompts      | 新建（name + node），自动创建空 v1（无标签）                                                                                                                                    |
| `GET /api/prompts/:id`                               | prompts      | 详情，含全部历史版本（供历史抽屉）                                                                                                                                              |
| `POST /api/prompts/:id/versions`                     | prompts      | 保存为新版本：body + note；服务端跑 `compilePromptBody()` 存结果，固定 `contract_version`（新 Prompt 默认所属节点最新 ContractVersion，历史副本沿用来源版本的 ContractVersion） |
| `PUT /api/prompts/:id/tags`                          | prompts      | body: `{ name, versionId }`，排他移动（§1 的 `ON CONFLICT` upsert）；`name='production'` 时仅走提示性确认，不做门禁                                                             |
| `DELETE /api/prompts/:id/tags/:name`                 | prompts      | 摘除标签                                                                                                                                                                        |
| `POST /api/prompts/:id/versions/:version/try-run`    | prompts      | 试运行，见 §6                                                                                                                                                                   |
| `GET /api/prompts/versions?node=<node>`              | prompts      | 该节点下所有 Prompt 的所有版本 + 标识，供应用表单下拉消费（应用前端调用 Prompt 域端点，方向不变）                                                                               |
| `GET /api/applications/prompt-usage?promptId=<uuid>` | applications | 「谁在用」只读派生视图，见 §4                                                                                                                                                   |

## Failure modes

| 场景                                            | 系统行为                                                                                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 并发标签移动竞态                                | `UNIQUE(prompt_id, name)` + `ON CONFLICT` upsert 保证最后提交的写入生效；前端在移动失败/结果与预期不符时提示刷新重试，不需要专门的乐观锁字段             |
| 试运行调用模型超时/失败（reply/fallback）       | 复用 M3 既有模型调用超时机制；试运行失败不影响该 Prompt 版本已保存的内容，只在结果区展示错误                                                             |
| M6 阶段对 rewrite/intent 发起试运行             | 后端硬编码返回 `{mode:'unavailable'}`，不静默返回假数据；前端按此渲染占位说明，不展示"运行结果"                                                          |
| 「谁在用」查询时 `applications` 服务不可用/超时 | Prompt 页面必须优雅降级为不展示徽标/条幅，不能因为这个只读增强功能拖垮 Prompt 详情页主体渲染——前端对该请求单独 try/catch，失败即隐藏相关 UI 而非阻塞页面 |
| 迁移窗口期数据不一致                            | 若旧 `status='prod'` 版本尚未跑迁移脚本打上 `production` 标签，「谁在用」会暂时不准（见 Rollout），不是长期状态                                          |

## Rollout & operations

这是对**已上线 schema** 的破坏性变更，分步、可暂停、可回滚：

1. 新增 `prompt_version_tags` 表；`prompt_versions` 新增可空/带默认值列 `contract_version`（默认 1）、`compile_status`、`compile_errors`。不删旧列，双写过渡。
2. 迁移脚本：为每个 `prompt_versions.status='prod'` 的版本，在 `prompt_version_tags` 插入 `(prompt_id, version_id, 'production')`；`status ∈ {draft, archived}` 的版本不处理，作为无标签的普通历史版本保留。
3. 核实应用侧（迁移到 009 目标模型后的 `applications` 模块）的 Prompt 版本候选查询逻辑：若存在按 `status='prod'` 过滤"可选版本"的地方，改为不过滤，返回该节点下全部版本（前端按标识排序/高亮）。当前旧 `agents.service` 的强制校验只有"node 归属一致"，不确定是否有额外 status 过滤，需要在 `/ship:design` 阶段核实具体查询实现；本文的迁移步骤与 009 的迁移步骤应协调执行顺序（009 已列出自己的七步迁移路径）。
4. 前后端全面切到 tags 读取路径，验证通过后：`drop` `prompt_versions.status` 列与其索引 `(prompt_id, status)`、`drop` `prompts.current_version_id` 列；`@codecrush/contracts` 中的 `PromptVersionStatusSchema` 删除，`PromptVersionSchema` 改为携带 `tags: string[]`。
5. 每一步都遵循"先加后用"，中途可以暂停在任意步骤；第 4 步执行前可以随时回滚到读 `status` 的旧路径。

## Observability

- 试运行调用应打上区别于正式问答的标记（如 span 属性 `rag.preview=true`，或使用独立的 `gen_ai.operation.name`），避免污染正式问答的成功率/延迟统计。
- Prompt 版本保存已经记录 `author`/`created_at`，无需新增审计字段。
- 「谁在用」查询失败应有日志但不需要触发告警（前端已按 Failure modes 优雅降级，不影响核心功能）。

## Security

- 标签操作沿用既定 Non-goal："任何操作者可自由创建/移动任意标签，本期不做权限管控"。
- 试运行会真实调用模型，输入数据（尤其从 Trace 导入的真实用户问题）可能含 PII；试运行的请求/响应不应写入除 Trace 外的持久化日志，导入的 Trace 数据本身遵循既有 Trace 脱敏规则。
- 「谁在用」端点只返回应用名称与版本号，不泄漏模型/知识库等应用内部配置细节。

## Alternatives considered

| 决策点                            | 选择                                                              | 拒绝                                        | 放弃了什么                                                                                                                            |
| --------------------------------- | ----------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| "谁在用"展示方式                  | 应用域只读派生视图                                                | 完全不展示（旧提案原意，被新原型推翻）      | 严格解耦的纯粹性——换来产品真实需要的可见性                                                                                            |
|                                   |                                                                   | Prompt 表持久化反查缓存列                   | 无级联维护负担——换来实时查询而非缓存                                                                                                  |
| 标签排他实现                      | DB 唯一约束 + 原子 `ON CONFLICT` upsert                           | 应用层先查后写（先删旧行再插新行）          | 多一次往返的"看似更清晰"分步操作——换来并发安全                                                                                        |
| NodeContract 静态字段契约落地时机 | 前置到纯函数包，随 M6 交付                                        | 整体等 011/M8.0 一起做                      | 无——这个决策没有实质代价：纯函数天然可以先于执行引擎独立存在，"等一起做"只是不必要的排序保守，且会与 002 既定的"M6 只依赖 M2"排序矛盾 |
| 试运行开放范围                    | 按节点分阶段（M6 开 reply/fallback，011 落地后开 rewrite/intent） | 整体推迟到 011 才开放试运行                 | 短期内 rewrite/intent 用户看不到试运行——换来 reply/fallback 立刻可用，没理由让已具备条件的两个节点陪不具备条件的两个节点一起等        |
| 版本追溯动作                      | 单一"创建副本"入口                                                | 旧提案设想的"创建副本 + 还原为此版本"双入口 | 语义上更精确的"revert"操作——换来更简单的心智模型，原型已证明产品侧收敛到单一交互                                                      |
| 标签表与应用标签表的关系          | 各自独立建表，只共用设计模式                                      | 建一张跨域共享的通用标签表                  | 更少的表数量——换来 `prompts`/`applications` 零耦合，各自演进不互相阻塞                                                                |

## Assumptions

1. `applications` 模块（009 落地后）愿意承接「谁在用」端点（跨模块协作前提，端点逻辑简单，成本低）。
2. `node-runtime` 执行引擎按 011 设计在 M8.0 落地，静态字段契约包会被 011 的 `NodeContract.templateFields` 复用而不是重复定义一份——需要在实现时警惕字段定义漂移成两份的风险（本文 Revisit triggers 已列出）。
3. 现有 `agents.service`（迁移到 `applications` 前）里 Prompt 版本候选校验逻辑的改动成本可控，属于本文小范围触达而非重新设计应用模块。
4. 试运行功能不需要严格的成本控额——当前量级下真实调模型测试的频率可控；若后续出现滥用需要补配额/限流机制（见 Revisit triggers）。
5. 本文的迁移节奏（Rollout）与 009 的迁移节奏彼此独立但需要协调——两者都涉及"从旧状态机迁移到标签模型"，实现顺序上先做哪个都可以，但不应在同一个 PR 里混合两个域的 schema 变更。

## Revisit triggers

- 单 Prompt 版本标签数远超个位数，或出现"谁能打 production"的权限诉求 → 需要重新设计标签模型 / 加权限层，当前 Non-goal 不再成立。
- 应用配置版本行数增长两个数量级（远超 009 假设的"数千行"量级）导致「谁在用」实时查询出现可感知延迟 → 引入索引优化或物化视图，重新评估 §4 的"不需要缓存"判断。
- 011 落地时若发现本文静态字段契约包与 `node-runtime` 执行器各自维护了一份字段定义并出现漂移 → 合并为单一注册表来源，静态包只做类型导出。
- 试运行调用量出现明显滥用或成本异常 → 补充配额/限流机制。

## References

- 现有实现：`apps/backend/src/modules/prompts/`、`apps/backend/src/modules/agents/`（迁移前）、`packages/contracts/src/prompts.ts`、`packages/contracts/src/prompt-template.ts`
- 架构：`001-rag-platform-architecture`（尤其 Invariant 6/7 与 Prompt 数据模型段落）、`002-implementation-roadmap`（M6/M8.0 波次与依赖排序）、`003-code-organization`（`node-runtime` 模块边界、isomorphic 共享包判据）
- 配套设计：[009-m7-application-management](009-m7-application-management.md)（应用不可变配置版本、单一 production 指针与异步 ReleaseCheck——本文 §4 的跨域协作对象）、[011-prompt-assembly-node-contracts](011-prompt-assembly-node-contracts.md)（NodeContract 执行引擎——本文 §5/§6 依赖的接口提供方）
- 原型：`RAG知识库问答系统设计/CodeCrushBot.dc.html`（最新版；不是仓库根目录同名旧文件，也不是 `-改版前备份`/`-print` 等旁支副本）
- 历史脉络（已删除，不再作为权威来源）：`docs/design/proposals/prompt-management-redesign.md`（产品设计输入）、旧 `011-prompt-assembly-node-contracts.md`（编号已被重新使用，见上）
