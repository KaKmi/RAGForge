---
title: "评测 worker 独立部署物（PROCESS_ROLE 分流）"
description: "把 eval-run + online-eval 两个 pg-boss 消费者拆到独立 worker 进程：同一代码按 PROCESS_ROLE 分流，租约代码零改动。"
category: "design"
number: "019"
status: draft
services: [backend, infra]
related: ["design/002", "design/003", "design/017", "design/018"]
last_modified: "2026-07-18"
---

# 019 — 评测 worker 独立部署物（PROCESS_ROLE 分流）

## Status

draft——设计已过 peer 对抗（0 P1 / 2 P2 / 4 P3，全部裁决并回写本设计），待实现落地并对照校验后升 current。

## Summary

`apps/backend` 的 `OnModuleInit` 挂着 4 个 pg-boss 消费者，其中 `eval-run`（一个 50 题 run = 17~38 分钟连续 LLM 调用）是主进程里最重的常驻批任务——逻辑上异步队列已解耦，物理上仍共享 event loop / 堆 / PG 连接池，且失败域未隔离（评测 OOM 会带走 chat API）。本设计把 `eval-run` + `online-eval` 拆到独立 worker 进程：**同一份代码、同一构建产物，按 `PROCESS_ROLE` 环境变量分流消费者**，租约与队列代码零改动。这是 018 §12 缺口 19 的收口，也是 003:256/:322「迟早会拆」预埋的首次触发。

## Context

- **来源**：018 §12 缺口 19（用户 2026-07-17 提出，完整理由与 ClickHouse 实测证据在彼处，不重复）。四条动机：物理未解耦（同进程共享 event loop/堆/连接池，长 run 期间 chat 尾延迟必受影响）、失败域未隔离、伸缩诉求相反（chat 低延迟横向扩 vs 评测长时吞吐）、生命周期绑死（关 API 即停评测）。
- **架构预埋**：003:256 给 ingestion 定过拆分阈值并承诺「Profile/Run 契约保持不变，只替换 Queue 消费部署物」；003:322 预告「出现第二个 Node 部署物 → `@codecrush/otel` 包价值凸显」。本设计不是新方向，是触发条件到了。
- **范围拍板（用户 2026-07-17）**：拆 `eval-run` + `online-eval`（同为 LLM 批任务）；`ingestion`/`release-check` 留 API 进程（003:256 阈值未触发）；同一代码按启动参数分流（非独立构建产物）；本地 dev 起两个 Node 进程，docker-compose 仍只管 infra；队列保持 pg-boss。

## Goals / Non-goals

**Goals**：失败域隔离、生命周期解绑、为两类进程独立伸缩铺路；rollout 对未设 env 的既有部署零变化。

**Non-goals**：
- 不拆 `ingestion` / `release-check`——003:256 阈值（排队 P95 >5min 或 >100 文档/分）未触发；触发时改 `QUEUE_CONSUMER_ROLES` 一行即可迁移。
- 不换队列——BullMQ/RabbitMQ 已评估否决（见 Alternatives）。
- 不做 worker 多副本——018 缺口 13（活跃槽位非原子守卫）未收口前不受支持；本设计把该前提从「单进程部署」改写为「worker 单副本」，语义等价。
  > ⚠️ **回写（2026-07-18，E-W2b 技术债收口波）**：缺口 13 **已收口**（部分唯一索引
  > `eval_runs_single_active_unique` + 23505 → 409），但**这不意味着本条前提已解除**。
  > 多副本还卡在**另一个**、019 当时未点名的阻塞项：018 缺口 10 的「**用例执行期间无心跳**」
  > 窗口——续租只发生在用例**之间**，单条用例跑满 `EVAL_RUN_CASE_TIMEOUT_MS`（默认 120s）
  > 期间租约不推进，故 TTL 与心跳的关系须另行论证。**「worker 单副本」前提继续有效。**
- 不修 018 缺口 15 的 (a)(b)(c)(d)（租约守卫 P3）、缺口 9（AbortSignal 硬中断）——属租约收口波。
- 不动 017（E-W1 冻结基线）：`online-eval` 只是换进程消费，判分逻辑/judgeVersion/解析契约一字不改。

## 数字（back-of-envelope）

- eval-run：50 题 × 20~46s/题 = **17~38min 连续 LLM 调用**/run（ClickHouse 实测，018 §12）。
- 租约余量：TTL 5min、逐题续租，最慢单题 46s ≪ 5min（≈6.5×），跨进程不变。
- online-eval：每 15min 一轮，单轮 ≤ `EVALUATION_CANDIDATE_LIMIT` 条，轮内串行。
- PG 连接：两进程各自 drizzle pool（默认 max 10，`persistence.module.ts` 裸建 `pg.Pool`）+ pg-boss pool（默认 10）+ pg-boss 每实例 1 条 LISTEN 专用连接 = **~42 总连接**，PG 默认 `max_connections=100`，余量 ~2.4×。
- pg-boss 轮询：消费者总数不变（4 个，分布 2+2），轮询 SQL 总量不变；boss 实例 ×2 → maintenance 双份，官方支持多实例，开销可忽略。

## Design

### D1 角色分流：`PROCESS_ROLE` + 单点解析

新 env `PROCESS_ROLE: api | worker | all`，**默认 `all` = 现行为**（未设变量的既有部署零变化，这也是回滚路径）。

**解析必须单点**（peer P2）：`main.ts` 的引导分支与 `tracing.ts` 的 serviceName 都在 Nest DI 容器建立**之前**就要读 role，若各自裸读 `process.env` 会与 `config.schema.ts` 形成三处独立解析，拼写/大小写分歧会静默走错引导路径。故新建**非 DI 纯函数** `platform/config/process-role.ts`：`parseProcessRole(process.env)` 返回枚举、**非法值直接 throw**——fail-fast 提前到 tracing 启动之前，杜绝「先以错误 serviceName 发几毫秒 span、随后才被 zod 拍死」的窗口。`config.schema.ts` 复用同一枚举常量。

消费者→角色映射**单点定义**在 `platform/queue/queue.constants.ts`（`QUEUE_CONSUMER_ROLES` 表，粒度 = Queue token）：

| 角色 | 消费 |
|---|---|
| `api` | ingestion、release-check |
| `worker` | eval-run、online-eval |
| `all` | 全部（现行为） |

消费门控收口在 **QueueModule 的 token 工厂**：4 个 Queue token 的 provider 用 `RoleGatedQueueAdapter` 包装 `PgBossQueueAdapter`——`subscribe`/`schedule` 在本进程角色不消费该 token 时 no-op（各记一条 log），processor 拿到的 Queue 实例已按角色裁剪，**零感知零改动**。**`publish` 恒透传**——任何角色都可入队（API 发起 run、worker 的 lease_busy 重投）。

> 修订记录（实现阶段，2026-07-17）：本段原写「4 个 processor 的 `onModuleInit` 开头统一守卫（`if (!consumesJob(role, JOB)) return`）」。实现调查改为 token 工厂门控：① Boundary 1 本就要求「processor 不得自带角色判断逻辑」，processor 内守卫行与之矛盾；② 咽喉点强制——「第 5 个消费者忘写守卫」的失败模式在工厂门控下不存在（拿不到未按角色裁剪的 Queue 实例）；③ processor 与其 7 处既有测试构造点零改动。详见 `.ship/tasks/eval-worker-split/plan/diff-report.md` 分歧 1。

### D2 worker 引导：application context，无 HTTP

`main.ts` 按 role 分支：

- `api`/`all`：现 bootstrap **原样一行不改**（`NestFactory.create` + listen）——落实「chat 零变化」。
- `worker`：`NestFactory.createApplicationContext(AppModule)` + `enableShutdownHooks()`。无 HTTP、无端口冲突、无重复 API 面；全部模块照常实例化，processor 的 `OnModuleInit` 照跑。

全仓当前**没有**任何 `enableShutdownHooks` 调用 → API 进程的 `boss.stop()`（`QueueModule.onModuleDestroy`）在信号驱动停机时从不执行。这是既有债务：本波只给 worker 分支加钩子，API 分支不动（不碰 chat 停机行为）。

### D3 可观测：serviceName 按角色

`tracing.ts` 经 `parseProcessRole` 选 serviceName：`codecrush-backend`（api/all）/ `codecrush-worker`。已验证读模型不按 ServiceName 过滤（`infra/clickhouse` 与 `apps/backend/src` 均无 ServiceName 谓词；`rag.eval` MV 只按 SpanName 过滤，018 决策 B）→ 屏 1/3 不受影响，运维新得「span 来自哪个进程」维度。

### D4 cron 归属与双实例调度

online-eval 的 `queue.schedule()` 跟随消费者（worker 角色注册，与 subscribe 同守卫）。已注册的 schedule 持久在 PG；pg-boss 的 cron 触发是 **DB 级单赢者**机制（`trySetCronTime` 对共享 version 表做条件 UPDATE，每 tick 全系统只有一个 boss 实例真正投递，外加 singletonKey 二重去重——`pg-boss@12.25.1/dist/timekeeper.js:104-119`，源码验证）→ worker 停机期间只要 API 的 boss 活着，cron job 照常入队（retryLimit:1、15min 过期），worker 回来即消化，良性积压；双实例**不会**双倍投递。

### D5 本地 dev：第二个 nest watch + 独立 outDir

`apps/backend` 加 `dev:worker: cross-env PROCESS_ROLE=worker nest start --watch --path tsconfig.worker.json`（零新依赖：`@nestjs/cli`/`cross-env` 均已在 devDeps）。`tsconfig.worker.json` 只改一件事——`outDir: ./dist-worker`，其余全继承 `tsconfig.json`；`dist-worker/` 进 `.gitignore`。api 侧 dev 脚本不动。

**为什么必须独立 outDir**：`pnpm dev` 会并行跑两个 `nest start --watch`，而 `nest-cli.json` 设了 `deleteOutDir: true` —— 共用 `./dist` 会让两者**互删对方的编译产物**（外加 Windows 上并发写同一批 .js 的 EBUSY/EPERM）。各自 outDir 后两个 tsc watch 完全隔离，且 worker 可独立启动（不依赖 api 的 dev 任务在跑）。

> 修订记录（QA 阶段，2026-07-17）：本段原方案是 **`tsx watch src/main.ts`**，理由写「不用第二个 `nest start --watch`——双 tsc watch 写同一 dist 会 EBUSY」。**该方案实测不可用**：tsx 基于 esbuild，**不支持 `emitDecoratorMetadata`**（本仓 `tsconfig.json` 开着它），不发射 `design:paramtypes` ⇒ NestJS DI 解析不出构造器参数，worker 进程启动即 `UndefinedDependencyException: Nest can't resolve dependencies of the ModelsService`。差分已证与角色无关：不带 `PROCESS_ROLE` 的裸 `tsx src/main.ts` 同样崩，而 `node dist/main.js`（tsc 产物）一切正常——故**生产形态从未受影响**，只有本地 dev 起不来。原方案对「共用 dist 会冲突」的判断是对的（且 `deleteOutDir: true` 让后果比预计更严重），错在选了个不发射装饰器元数据的编译器；解法是保留第二个 nest watch、给它独立 outDir。证据见 `.ship/tasks/eval-worker-split/qa/api-report.md` P1。

**turbo 接线两处都要做**（peer P2：`turbo run dev` 按任务名调度，不会自动带上 `dev:worker`）：
1. `turbo.json` 加 `"dev:worker": { "dependsOn": ["^build"], "cache": false, "persistent": true }`——`dependsOn` 必须有：`@codecrush/otel` 的 main 指向 dist，冷启动未 build 时 worker 编译会 MODULE_NOT_FOUND（实现阶段修订，原文缺此字段）；
2. root `package.json` 的 `dev` 脚本改为 `turbo run dev dev:worker`（对没有该脚本的包 turbo 自动跳过）。

### D6 部署形态

同一构建产物（`dist/main.js`）：`PROCESS_ROLE=api node dist/main.js` / `PROCESS_ROLE=worker node dist/main.js`。compose 目前无 app 服务（infra-only），生产接线留待上线波，本 doc 只定契约。

### D7 其余 OnModuleInit 钩子清查

全仓 `OnModuleInit` 共 6 处：4 个 processor + `QueueModule`（`boss.start()`，两类进程都要）+ `ClickHouseMetricsRepository`（启动执行 metrics VIEW DDL）。后者两条语句均 `IF NOT EXISTS`（`infra/clickhouse/views/002-metrics-views.sql`）且外层 try/catch 不阻断启动 → worker 重复执行幂等无害，**不做角色门控**（门控反而引入「只起 worker 时 VIEW 缺失」的新路径）。`OnApplicationBootstrap` 全仓零处；migrate/seed 是独立 CLI 脚本，不在 bootstrap 路径上。

## 失败模式

| 场景 | 行为 |
|---|---|
| worker OOM/被杀（run 进行中） | chat 无感。租约 5min 过期；pg-boss job 15min 过期重投（retryLimit 3）；新 worker 经 `listRecordedCaseVersionIds` 断点续跑，最多丢当前一题（018 §11 既有设计） |
| worker 停机 >15min 且期间有人 POST /eval/runs | queued run 被回收器判 failed，横幅「超过宽限期仍无 worker 接管，可重新发起」——018 缺口 11 的文案正为此写 |
| API 停机 | worker 直连 PG，跑完当前 run；无新 run 可发起 |
| 误配双进程都 `all` | pg-boss `FOR UPDATE SKIP LOCKED`（`plans.js:1197`）+ per-run 租约 → 退化为今天的语义，安全（这正是回滚路径的安全性证明） |
| role 拼错 | `parseProcessRole` 在 tracing 启动前 throw，进程不起 |
| worker 少配 env | 两进程读同一 .env，同一 config.schema fail-fast |
| worker SIGTERM | `enableShutdownHooks` → `boss.stop()`（graceful 默认等 30s）；长 run 的 handler 等不完 → 强停 → 走 OOM 行的续跑路径 |

### 租约语义复核（018 缺口 11/13/14/15 在多进程下的结论）

- **eval-run per-run 租约不需要为拆分改一行代码**：owner UUID + 条件更新（`WHERE lease_owner = owner`）+ lease_busy 重投**本就按多 worker 设计**；租约原语全部是 DB 条件更新，今天单进程 `all` 模式下经异步交错 + 独立 DB 连接已有同形竞态——跨进程只改变时序分布，**不引入新竞态类别**（peer 独立验证）。
- 「全局最多 1 个 run」的实际保证从「单进程内 pg-boss 串行 await」平移为「**worker 单副本内串行**」：`subscribe()` 调 `boss.work()` 不传并发参数（`pg-boss-queue.adapter.ts:38-45`），pg-boss 默认 `batchSize=1` 逐 job 串行。语义等价，缺口 13 的 TOCTOU 双开不变不恶化。
- online-eval 的 workerName 键租约跨进程原生成立。
- 回收器只在 API 进程触发（`eval-runs.service.ts:172`，`create()` 内）；worker 分进程后回收器↔worker 竞争从同进程交错变成真并行，但缺口 11 两条不变式（持活租免疫回收 / 失租者不得推进状态）正是为此设计，`eval-runs.lease.db.spec.ts` 真库钉死。缺口 15 (a)(b) 残余窗口概率不变（取决于单题卡 >20min，provider HTTP 60s 超时下不可达），仍留 W2b。

## Rollout & operations

- **迁移**：合并后未设 env 的部署行为不变（`all`）；切换 = API 侧设 `PROCESS_ROLE=api` + 起一个 `PROCESS_ROLE=worker` 进程。顺序无所谓（`all`∩`worker` 共存安全，见失败模式表）。
- **回滚**：撤 worker 进程 + 删 API 的 env。零 schema、零数据迁移——两-way door。
- **工作信号**：启动日志「role=worker, consuming: eval-run, online-eval」；OTel serviceName 维度；`GET /eval/runs/:id` 的 doneCases 在涨。
- **不工作信号**：run 停在 queued 不动（worker 没起）；回收横幅出现。
- **验收路径**（QA 用）：role=api 进程发起 run → 本进程不消费；role=worker 消费并跑完；双 `all` 共存不重复判分。

## Security

无新信任边界：worker 无 ingress（无 HTTP），出边（PG/ClickHouse/LLM provider）与密钥面与现状完全一致，读同一 .env。

## Boundaries

1. **消费者→角色映射只活在 `platform/queue/queue.constants.ts` 的 `QUEUE_CONSUMER_ROLES` 一处**（粒度 = Queue token；新消费者域一律开新 token 并登记角色）；任何 processor 不得自带角色判断逻辑。
2. **`PROCESS_ROLE` 的解析只活在 `platform/config/process-role.ts` 一处**；`main.ts`/`tracing.ts`/`config.schema.ts` 一律经它，禁止再出现裸读 `process.env.PROCESS_ROLE` 的第二处。
3. **`publish` 永不按角色设防**——入队是所有角色的能力，只有消费被门控。
4. **api/all 的 bootstrap 路径不改**：`NestFactory.create` 分支的行为与本设计前逐字节等价（chat 零变化的落点）。
5. **worker 多副本不受支持**，直到 018 缺口 13「活跃槽位资源化」收口——这条前提写在文档里，不留在代码里当默契（018 缺口 13 原「单实例部署」表述由本条替代）。
6. **评测语义零改动**：judge 逻辑、租约原语、run 状态机、`rag.eval` 读模型均不因拆分而变；017 冻结基线不动。

## Alternatives considered

1. **独立 `apps/worker` 构建产物**——物理边界最清晰，但要抽共享模块 + 维护双构建，当下零收益（用户拍板否）。Revisit：想裁剪 worker 依赖面（不带 HTTP 栈）时。
2. **worker_threads / 子进程内嵌**——线程共堆，OOM 失败域不隔离；生命周期仍绑 API。伪隔离。
3. **换 BullMQ（sandboxed processor）**——引入 Redis 新有状态基础设施、丢「业务写 + 入队」同 PG 事务性（要补 outbox）；队列替换是独立决策，不与拆进程捆绑。
4. **worker 起完整 HTTP app 于第二端口**——重复 API 面（worker 也能被打 /chat）、端口管理负担。代价：worker 无 /health 探针（见 Revisit）。
5. **`PROCESS_ROLE` 必填无默认**——既有部署升级即炸，违背零变化。

## Assumptions

- A1：worker 无 /health 探针可接受——本地 compose 不编排 app 服务，进程存活即信号。
- A2：API 进程的优雅停机缺失是既有债务，本波不修（只给 worker 加 shutdown hooks）。
- A3：serviceName 拆成 `codecrush-worker` 不影响任何读模型（静态验证已过：init SQL 与 src 无 ServiceName 过滤；QA 波以实测再兜一层）。
- A4：`pnpm dev` 默认带起 worker（而非可选加开）符合本地开发体验拍板的意图。

## Revisit triggers

- worker 需要多副本 → 先做 018 缺口 13「活跃槽位建模成有所有者与过期证据的资源」，否则不支持。
- worker 进 k8s / compose `--wait` 编排 → 给 worker 分支加轻量 liveness 端点（当前无 HTTP）。
- ingestion 排队 P95 >5min 或 >100 文档/分（003:256）→ 把 ingestion 迁到 worker 角色，改 `QUEUE_CONSUMER_ROLES` 一行。
- 评测吞吐要并行多 run → 同缺口 13，且需重估 token 预算的全局性。

## 对抗记录

- 完整对抗档。Codex peer 不可用（账号/版本不匹配），fallback 为 `claude -p` 全新同厂会话——独立性弱于跨厂 peer，记录在案。
- Peer 产出 0 P1 / 2 P2 / 4 P3，全部采纳：turbo 接线具体化（D5）、`parseProcessRole` 单点解析（D1）、连接数修正 ~42（数字节）、cron 机制表述精确化（D4）。
- Peer 独立验证成立：租约原语跨进程不引入新竞态类别；回收器仅 API 进程触发；`boss.work()` 默认串行；SKIP LOCKED 保证回滚路径安全。

## References

- 018 §12 缺口 19（动机与实测证据）、缺口 9/11/13/14/15（租约语义）
- 003:245-330（拆分阈值预埋、通用 Telemetry SDK 与包边界）
- 017（E-W1 冻结基线，不动）
- AGENTS.md 边界 7（埋点绝不进入问答关键路径）
