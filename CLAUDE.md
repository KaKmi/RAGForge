# CLAUDE.md

Claude Code 专用指引。**先读 [`AGENTS.md`](AGENTS.md)**（环境、命令、结构、依赖边界、约定），本文只补充 Claude/Ship 特有事项。

## 权威来源顺序

1. `docs/design/001–003`（架构 / 路线图 / 代码组织）——**设计权威，改架构先改文档**。
2. `AGENTS.md`——工程约定与依赖边界。
3. 代码与 `.ship/tasks/<task>/`（spec/plan/ledger）。

设计文档目前状态 `draft`（Ship 规范：`current` 要求与生产代码对齐；实现落地并对照校验后才升 `current`）。

## 本项目用 Ship 工作流

- 规划：`/ship:arch-design`（系统设计思考）→ `/ship:write-docs`（落 `docs/design/`）。
- 实现：`/ship:design`（拆 spec+plan 到 `.ship/tasks/`）→ `/ship:dev`（按 story 实现、测试、提交）。
- 复核：`/ship:review`（静态）/ `/ship:qa`（运行时）。
- **按里程碑分波推进**（M0 → M0.5 → M1 …），一波一个 design→dev 闭环，不要一次规划全部。
- 恢复：`.ship/tasks/<task>/dev-ledger.md` 记录已完成 story，优先信它与 `git log`，勿重复实现。
- **收口回写路线图（每波 handoff 必做）**：一波 handoff 时，回写 `docs/design/002` 对应里程碑行的交付进度（哪波已交付 + PR 链接 / 哪波待做）。原因：`.ship/` 被 gitignore，分波拆分与进度只活在本地任务产物里；不回写，新会话在 `main` 上会据「代码已合并」误判里程碑完结（M8 曾踩此坑，见 002 的「M8 分波交付进度」表）。跨会话可见的**进度状态**走已提交的 002，**设计范围**走已提交的 `docs/design/`，两者都不依赖 `.ship/`。

### 对抗强度分级（用户已拍板，2026-07-05）

按任务性质选档，开工时向用户说明用哪档（用户可否决）：

- **完整对抗**——架构性任务（引入新模块边界/存储 schema 决策/安全信任面/编排内核，如 M4 入库管线、M5 检索、M8 RAG 编排+SSE、M9 trace 读模型）：
  design = peer 独立调查 + diff + execution drill；dev = 每 story 独立 peer review。
- **轻量对抗**——CRUD/骨架/配置型任务（如 M2 页面骨架、M3 模型接入、M6 Prompt、M7 Agent 配置、M10 看板）：
  design = peer 独立调查 + diff，**跳过 execution drill**（host 自查 plan 代替，理由记入 report card）；
  dev = **不做每 story 审**，整个任务收尾跑一次 review 覆盖全量 diff；仅涉及安全/数据完整性的个别 story 单独审。
- 判定依据：是否新增模块边界、是否碰存储 schema、是否在信任边界上动刀。拿不准取高档。

## 提交/推送纪律

- 仅在用户明确要求时提交或推送。
- 默认分支上工作前先开分支。
- Commit 用 Conventional Commits，结尾加：
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

## ⛔ 危险动作红线（用户拍板 2026-07-19，事故后追加）

**绝不允许清空、重置、drop、truncate 开发库 `codecrush`（docker `codecrush-postgres-1`）。**

该库里有用户**手工搭建、无法脚本重建**的数据：模型接入（含加密密钥）、知识库、已上传并解析完成的文档与切片、应用与已上线配置版本。**WAL 归档 `off`、无备份、无卷快照 ⇒ 删了就是永久丢失。**

- 需要干净状态：一律用专用库 **`codecrush_mig_test`**（`MIGRATION_TEST_DATABASE_URL` 指向它，那些 spec 本就 `DROP SCHEMA`，随便删）。
- 清理自己造的夹具：**按 id 精确删**，不要整表 `delete` / `truncate`。
- 在真库上跑任何测试/QA 前，**先备份**：`docker exec codecrush-postgres-1 pg_dump -U codecrush codecrush > <scratchpad>/codecrush-<ts>.sql`，并在报告里说明备份位置。
- **派 subagent 做 QA/dev 时，必须把这条红线写进它的任务书**——agent 从零搭环境时最容易伸手重置数据库。
- 写「服务在不在跑」这类环境状态前**先实测**（`Get-NetTCPConnection -LocalPort 3000,5173`），不要凭上文记忆断言。给错环境信息会逼 agent 自行搭环境，正是事故起点。

> 事故留档（2026-07-19）：B1 运行时 QA 中，我派的 QA agent 在开发库上重置了数据，用户的应用/知识库/模型接入全部丢失、不可恢复。当时任务书保护了 docker infra（「别 down」）、端口与 dev 服务，**唯独没保护库里的数据**；且我断言「:3000/:5173 已在运行」而实际没有，agent 因此从零搭环境。两处都是我的失职。

同类红线（同源：先看现状再动手）：
- 不擅自启停 Windows 服务 / 不按端口批量 kill 进程（会误杀用户常驻的 dev 服务）。
- 改 `.env` 前先读现值，非占位符就别覆盖（曾误转密钥致数据不可解密）。

## 高频提醒

- 改动后必跑 `pnpm test` 与 `pnpm lint`（边界规则必须 0）。
- 依赖服务要先 `docker compose -f infra/docker-compose.yml --profile infra up -d --wait`。
- 可观测/追踪相关：遵 OTel GenAI 语义约定（`gen_ai.*` / 自定义 `rag.*`），SDK 通用（支持 chat/embeddings/tool/agent/retrieval，不绑 RAG）——细节见 `003` 的「通用 Telemetry SDK 与包边界」。
- 用户对 OTLP/ClickHouse 细节不熟，涉及时讲清楚「为什么标准/可迁移」。
- **写/改任何前端页面前，必须先读原型对应屏并 1:1 还原**（布局/文案/交互/视觉细节，不是"大概像"；用户拍板 2026-07-12）：原型 = `RAG知识库问答系统设计/CodeCrushBot.dc.html`（该目录最新版为准；不进仓库见 `.gitignore`，不进打包；仓库根旧副本、`-改版前备份`/`-print` 等旁支副本均已过期勿用）。M2 曾据旧版还原 15 屏，后续页面一律以设计目录最新版为准。详见 [`AGENTS.md`](AGENTS.md)「原型参考」。
- **前端组件优先用 antd**（用户拍板，2026-07-08）：能用 antd 组件实现的一律用 antd（Modal/Drawer/Table/Form/Upload/Select/message/Popconfirm 等），不要手写替代物（如 `window.confirm`、自制表格/弹层/开关）；自定义 style 仅用于 antd 覆盖不到的视觉细节还原。
