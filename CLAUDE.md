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
