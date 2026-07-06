---
title: "用户/认证（M1）"
description: "M1 身份边界：users 叶子 + auth 横切、argon2id、JWT HS256、全局 default-deny guard；四条数据流图与失败模式。"
category: "design"
number: "005"
status: draft
services: [backend]
related: ["design/001", "design/002", "design/003"]
last_modified: "2026-07-05"
---

# 005 — 用户/认证（M1）

## Status

draft——随 M1 实现落地并对照校验后升 current。选型已经 /ship:design 对抗验证定案（见 `.ship/tasks/m1/plan/diff-report.md`），本文是系统视角的梳理与图示，不重开决策。

## Summary

给后端建立第一道身份边界：demo/admin 单角色登录（JWT HS256, 12h），**全局 default-deny**——每个非 `@Public()` 路由必须携带合法 Bearer token。`users` 叶子模块持有实体与密码学，`auth` 横切模块持有登录与 guard；密码用 argon2id，`JWT_SECRET` 进 env fail-fast。

**用户的定义**：本文与 M1 的 user 一律指**平台/管理台的操作者**（后端系统用户：admin、demo），不是 C 端最终用户。C 端用户（若未来经 API/挂件接入问答）是独立概念，不复用本表——见 Assumptions 与 Revisit。

## Boundaries

**In-scope（M1）**
- users 实体（Drizzle 0001 迁移）+ demo seed（显式命令）
- `POST /auth/login`、`GET /users/me`、`PATCH /users/me/password`
- 全局 `JwtAuthGuard` + `@Public()`（`platform/security`）；`/health`、`/auth/login` 公开，`/traces/*` 收保护

**Out-of-scope（有意排除）**
- RBAC/多租户（M12）、注册/邀请/找回密码、refresh token、登出/token 吊销、限流、前端登录页（M2）

**Invariants**
1. `password_hash` 出 repository 即被 service 消毒，**永不出现在任何 API 响应**。
2. `JWT_SECRET` 必填 min32、无默认值——缺失即启动失败，宁可不起不裸奔。
3. seed 永不随应用启动执行；幂等 = 已存在则零变更（不覆盖密码）。
4. 新增路由默认在保护圈内（default-deny）；公开必须显式 `@Public()`。
5. `/traces/*` 不得为保脚本绿而标 @Public——消费者（verify 脚本）改为真登录。

## 关键数字（back-of-envelope）

内部工具，用户个位数，QPS 可忽略。唯一负载数字是 **argon2id（m=64MB, t=3, p=1）**：

- 每次登录/改密 verify ≈ 50–100ms CPU + **64MB 峰值内存**；5 并发登录 ≈ 320MB 瞬时，单容器无压力。
- guard 热路径是 HMAC 验签（≈µs 级），每请求鉴权开销可忽略——**贵的只有登录**，这是有意的形状（防爆破成本压在密码哈希上，不在热路径上）。
- 10× 偏差（50 并发登录）≈ 3.2GB 内存尖峰会打爆容器 → 见 Revisit 3。

## 信任边界总览

```
        不可信                    信任边界①                可信（进程内）              信任边界②
┌──────────────┐   HTTPS+JWT   ┌─────────────────────────────────────────┐   内网/本地   ┌──────────┐
│   浏览器/CLI  │ ────────────► │  NestJS: JwtAuthGuard(全局 default-deny) │ ───────────► │ Postgres │
│(含 verify 脚本)│              │  @Public 豁免: /health, /auth/login       │              │  users 表 │
└──────────────┘               │  request.user = {id,email} ← JWT 验签     │              └──────────┘
                               └─────────────────────────────────────────┘
  秘密所在: JWT_SECRET(env, fail-fast) · password_hash(仅存 DB, service 层出口即消毒)
```

云上映射沿用 001：env 密钥 → KMS；PG → RDS 内网。

## 数据流

### 流 1 — 登录签发 token

```
浏览器 ──POST /auth/login {email,password}──► AuthController(@Public)
  │  LoginRequestSchema.parse ──畸形──► 400
  ▼
AuthService.login ──► UsersService.validateCredentials
  │                     ├─ normalizeEmail → UsersRepository.findByEmail → PG
  │                     ├─ 用户不存在 ──► verify(dummyHash) ①  ──► null
  │                     └─ 存在 ──► argon2.verify(hash, pw) ──错──► null
  │                                                        └─对──► sanitized profile ②
  ├─ null ──► 401 "invalid credentials"（不区分原因，防枚举）
  ▼
JwtService.signAsync({sub,email}, HS256, JWT_SECRET, 12h)
  ▼
200 {accessToken, tokenType:"Bearer", expiresIn:43200, user}

  ① 时序均衡：未知用户也跑一次 verify，抑制用户枚举
  ② password_hash 在此消失，永不上行
```

### 流 2 — 受保护请求经 guard（每个非 @Public 请求）

```
请求 ──► JwtAuthGuard.canActivate
  ├─ Reflector 查 @Public(handler→class) ──是──► 放行（不碰 token）
  ├─ 无 Authorization / 非 "Bearer " ──► 401
  ├─ verifyAsync(token) 失败（篡改/过期/错签）──► 401
  └─ 成功 ──► request.user = {id:sub, email} ──► controller
                └─ 新增路由默认在保护圈内（default-deny，fail-closed）
```

### 流 3 — 改自己密码

```
PATCH /users/me/password ──guard──► UsersController
  │ ChangeOwnPasswordRequestSchema.parse ──畸形──► 400
  ▼
UsersService.changeOwnPassword(req.user.id, current, new)
  ├─ findById 无此人 ──► 404
  ├─ verify(current) 错 ──► 401
  └─ hash(new) ──► updatePasswordHash ──► PG
       └─ 注意：旧 token 仍有效至过期（JWT 无状态固有语义，M1 接受）
```

### 流 4 — demo seed（显式命令）

```
pnpm db:seed ──► tsx src/db/seed.ts
  ├─ dotenv: DATABASE_URL / DEMO_USER_PASSWORD(默认 CodeCrushDemo123!)
  ├─ argon2.hash(password)
  └─ INSERT users ON CONFLICT(email) DO NOTHING ──► PG
       └─ 已存在 → 零变更（幂等=不覆盖；重置密码走改密接口，不靠重 seed）
```

## Failure modes

| 故障 | 影响面 | 行为 |
|---|---|---|
| PG 挂 | 登录/me/改密 | 5xx；/health 公开且自报 `db:down`，可诊断 |
| JWT_SECRET 缺失/过短 | 启动 | boot 即 ZodError 退出（fail-fast） |
| JWT_SECRET 轮换 | 全部存量 token | 立即全体失效 → 重新登录；12h 有效期使代价可接受 |
| token 被盗 | 单账号 | M1 无吊销（接受的风险）；上限 = 剩余有效期 ≤12h |
| 改密后旧 token | 单账号 | 仍有效至过期；吊销归 M12 |
| 并发登录爆破 | 内存 | argon2 64MB/次 × 并发；无限流（非目标）→ Revisit 2/3 |
| guard 非预期异常 | 全站 | fail-closed：异常=拒绝，不漏放 |

## Rollout & operations

上线 = `pnpm db:migrate`（0001 纯增量建表）+ `pnpm db:seed` + .env 补 `JWT_SECRET`。回滚 = 回退代码（表留存无害）。"在工作"信号：demo 登录 200 + 无 token 打 `/traces/hello` 得 401；M0.5 的 `observability:verify`（已改带登录）即持续冒烟。

## Alternatives considered

选型已在 /ship:design 阶段经 codex 对抗验证定案，此处只记结论（详见 `.ship/tasks/m1/plan/diff-report.md`）：

| 决策 | 选择 | 否决项与理由 |
|---|---|---|
| 密码哈希 | argon2id（OWASP 参数档） | bcrypt：72 字节截断、非 memory-hard |
| JWT 库 | @nestjs/jwt | jose：v5+ ESM-only 炸 CJS；passport：单 JWT 场景多余间接层 |
| 模块归属 | 独立 users 叶子 | 并入 auth：conversations.user_id 外键将违反「别的模块不 import auth」（003） |
| 横切件位置 | platform/security | 放 auth 内：health 豁免时被迫 import auth |
| seed 冲突 | DO NOTHING（不覆盖） | upsert 覆盖：重跑 seed 会静默重置密码，违反最小惊讶 |

## Assumptions

- **users 表只承载平台操作者**：001 数据模型的 `conversations.user_id` 指管理台操作者（在测试台/试运行发起的会话）。若未来出现 C 端最终用户，另建概念（独立表或外部身份），不往本表塞角色字段。
- 内部工具、无公网暴露（破 → Revisit 2 提前）。
- 单实例部署（JWT 无状态，多实例本身不破坏设计，只影响未来吊销方案）。

## Revisit triggers

1. **M8 SSE 鉴权**：`EventSource` 不能带 Authorization 头——chat 流式接口需 query-token 或 cookie 方案，**M8 design 必须解决**（本设计的红队发现）。
2. 对公网开放或多真实操作者 → 补登录限流 + token 吊销（配合 M12 RBAC）。若接入 **C 端最终用户**（问答挂件/开放 API）→ 独立身份方案（匿名会话 / API key / 外部 IdP），不扩展本表。
3. 登录并发 >20 → argon2 内存尖峰需队列化或降 memoryCost。

## References

- `.ship/tasks/m1/plan/spec.md` / `plan.md` / `diff-report.md` — 实现规格与选型裁决
- 001 §信任边界/安全、002 波次 B（M1 行）、003 §模块边界（users 叶子 + auth 横切）
