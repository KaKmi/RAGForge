# Diff Report — M1 host spec vs peer spec

Peer runtime: codex（非 host provider，独立调查），thread `019f3262-eace-79f0-aa8a-9fbab6b449cd`。

## D1 — users 独立模块 vs 并入 auth
- Host: user 实体/服务归 modules/auth（003 模块清单无 users）。
- Peer: 新建 modules/users 叶子模块，auth→users；**先更新 003** 再写码。
- 证据: 003:130「别的模块不 import auth」——将来 `conversations.user_id` 外键在 Drizzle 里要 `references(() => users.id)`，即 conversations/schema.ts 必须 import 拥有 users 表的模块的 schema。若表在 auth 内则违反边界；独立 users 叶子（仅依赖 persistence）可被任何域安全引用。且 CLAUDE.md「改架构先改文档」支持 peer 的文档先行。
- **Disposition: conceded**（采 peer）。003 补 users 叶子 + `auth → users, config` 依赖边。

## D2 — 登录标识 email vs username
- Host: username（demo）。Peer: email（demo@codecrush.local，trim+lowercase 规范化）。
- 证据: 设计文档未规定。email 的唯一性/规范化惯例成熟，未来邀请/通知流自然。
- **Disposition: conceded**（采 email；demo 账号 demo@codecrush.local）。

## D3 — /users/me、改密端点放 M1a 还是 M1b
- Host: M1a 纯数据层，HTTP 全在 M1b。Peer: M1a 就建两个端点，"require auth once M1b is active"。
- 证据: M1a 无 guard ⇒ `request.user` 不存在，/users/me 无身份来源不可用；PATCH password 会**无鉴权裸奔一波**（任何人可改 demo 密码）。
- **Disposition: proven-false**（peer 错）。维持 host：端点全部落 M1b。

## D4 — @Public()/principal 类型放 platform/security 还是 auth 模块
- Host: auth 模块内。Peer: `platform/security/`。
- 证据: health 要用 @Public()；若在 auth 内，health import auth 违反 003:130。所有域→platform 是合法方向 [003:132]。
- **Disposition: conceded**（采 peer）。

## D5 — newPassword 长度 8 vs 12
- 证据: 无内部权威；NIST 800-63B 最小 8。内部工具。
- **Disposition: patched**——min 8, max 128（max 防长密码 DoS，采 peer 的上限、host 的下限）。

## D6 — token 有效期 12h(env 可配) vs 固定 8h
- **Disposition: patched**——合并：`JWT_EXPIRES_IN` env 默认 "12h"（host 可配性），LoginResponse.expiresIn 返回秒数（peer 明确性）。

## D7 — seed 命名 db:seed/seed.ts vs db:seed:demo/seed-demo-user.ts
- **Disposition: patched**——采 host `db:seed` + `src/db/seed.ts`（与 migrate.ts 对称；未来扩展仍走同一命令）。

## D8 — 是否加 supertest 应用级 guard 测试
- Peer: 直连 controller 的单测不经过全局 guard，401 语义需 app 级 HTTP 测试（supertest）。
- 证据: 现有 test/*.spec.ts 全部直连 [test/traces.controller.spec.ts]，guard 不生效属实。
- **Disposition: conceded**——新增 supertest 测试模块（mock DRIZZLE/CLICKHOUSE providers），跑 401/公开/带 token 矩阵。

## D9 — argon2 参数
- **Disposition: conceded**——argon2id, memoryCost 65536, timeCost 3, parallelism 1（OWASP 推荐档）。

## D10 — JWT claims
- 随 D2：`{sub: user.id, email}`。**patched**。

## D11 — verify 脚本 token 来源
- **Disposition: patched**——合并：`AUTH_TOKEN` env 优先，否则用 demo 凭据登录（peer 的 env 逃生口 + host 的默认登录流）。

## D12 — display_name 可空性
- **Disposition: conceded**——not null，seed "Demo Admin"（前端省 null 分支）。

## D13 — 改密响应体
- **Disposition: conceded**——`{ status: "ok" }`（contracts 定 schema）。

## D14 — validateCredentials 归属
- 随 D1 拆分：UsersService.validateCredentials(email, password)，AuthService 调用后签 token。**conceded**。Host 独有的「未知用户 dummy argon2.verify 抑制枚举时序」保留（peer 未提，无冲突）。

## 已验证非问题
- peer 提示 `uuid defaultRandom` 可能需要 pgcrypto：PG13+ 内置 `gen_random_uuid()`，pgvector/pg16 无需扩展。plan 中仍保留「检查生成的迁移 SQL」步骤兜底。

## Escalations
无。D2/D5/D6/D7 属规约级选择，均以证据或惯例定夺并记录。
