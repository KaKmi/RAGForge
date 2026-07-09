# Diff Report — spec.md vs peer-spec.md

> 说明：peer-spec 为自产（未 spawn 子代理，见其 WARNING）。故分歧本质是"对抗性自审补强"，均由工具事实/文档一致性判定，无需 debate。全部 `patched`。

| # | 分歧点 | host spec | peer spec | 判定依据 | 处置 |
|---|---|---|---|---|---|
| D1 | 健康检查实现 | 手写 `/health` + DB ping | ~~用 `@nestjs/terminus`~~ → 手写（复议后反转） | 写 complete code 时发现 terminus v10(`HealthIndicator.getStatus`) 与 v11(`HealthIndicatorService`) API 有 breaking change，给 M0 平添版本风险而无收益 | **patched（反转 D1）**：手写极简 health controller（`SELECT 1` ping，返回 `@codecrush/contracts` 的 `HealthResponse`），terminus 延到需要富健康检查时 |
| D2 | 边界 lint 插件 | 主推 `eslint-plugin-boundaries` | M0 用 `import/no-restricted-paths`，boundaries 插件延后 | M0 后端域模块尚不存在，boundaries 的 elements/rules 空转；FE/BE/contracts 两条硬边界用 `no-restricted-paths` 更稳且可立即验证 | **patched**：M0 用 `import/no-restricted-paths`；完整 boundaries 延到 M1（**这是对 003 的 M0 时序细化，非推翻**） |
| D3 | 前端调后端跨域 | 未提（遗漏） | 加 Vite dev `proxy` | 5173→3000 触发 CORS；proxy 免 CORS 且不硬编码 host | **patched**：加 Vite `/health`(及未来 `/api`) proxy |
| D4 | config env 必填边界 | 未枚举 | M0.5 变量须 `.optional()` | 否则 M0 因缺 M0.5 变量 fail-fast，自相矛盾 | **patched**：M0 必填仅 `DATABASE_URL/PORT/NODE_ENV`，CH/OTLP 可选 |
| D5 | pgvector 镜像 | "pgvector 镜像"（含糊） | 明确 `pgvector/pgvector:pg16` + 示例表不含 vector 列 | `CREATE EXTENSION vector` 需镜像自带扩展二进制 | **patched**：明确镜像；M0 示例表无 vector 列，扩展仍装好供 M4 |
| D6 | turbo dev 任务 | 未细化 | `dev` 设 `persistent:true`+`cache:false` | 长驻 dev server 不能被缓存/须持久 | **patched**：写入 turbo pipeline |
| D7 | 包命名 | `@codecrush/contracts`（未统一） | 统一 `@codecrush/*` scope | 一致性 | **patched**：统一 scope + `workspace:*` |
| D8 | Drizzle 脚本 | 只强调 migrate | `db:generate` + `db:migrate` 均需 | 迁移工作流需生成 + 应用两步 | **patched**：两条脚本齐备，迁移文件入库 |

**Escalated**：无。
**Re-investigation**：无（greenfield，无既有代码盲区）。

所有 patched 项已回写 `spec.md`。
