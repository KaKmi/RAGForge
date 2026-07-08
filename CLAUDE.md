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

## 高频提醒

- 改动后必跑 `pnpm test` 与 `pnpm lint`（边界规则必须 0）。
- 依赖服务要先 `docker compose -f infra/docker-compose.yml --profile infra up -d --wait`。
- 可观测/追踪相关：遵 OTel GenAI 语义约定（`gen_ai.*` / 自定义 `rag.*`），SDK 通用（支持 chat/embeddings/tool/agent/retrieval，不绑 RAG）——细节见 `003` 的「通用 Telemetry SDK 与包边界」。
- 用户对 OTLP/ClickHouse 细节不熟，涉及时讲清楚「为什么标准/可迁移」。
- 前端页面还原参考「RAG知识库问答系统设计/」目录下的最新原型（`CodeCrushBot.dc.html` 等，不进仓库见 `.gitignore`，不进打包；仓库根的旧副本已过期）；M2 曾据旧版还原 15 屏，后续页面以设计目录最新版为准。详见 [`AGENTS.md`](AGENTS.md)「原型参考」。
- **前端组件优先用 antd**（用户拍板，2026-07-08）：能用 antd 组件实现的一律用 antd（Modal/Drawer/Table/Form/Upload/Select/message/Popconfirm 等），不要手写替代物（如 `window.confirm`、自制表格/弹层/开关）；自定义 style 仅用于 antd 覆盖不到的视觉细节还原。
