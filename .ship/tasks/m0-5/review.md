# Code Review — M0.5 可观测最小闭环（03c22ea...HEAD）

Spec: `.ship/tasks/m0-5/plan/spec.md`（12 条验收标准全部核验，全部满足；运行时证据见 dev-ledger）。
per-story peer review 已覆盖 5 个 story（4×PASS + 1×PASS_WITH_CONCERNS 已修复）；本轮是全 diff 的独立静态终审。

## Findings

> **2026-07-05 fix 轮**：以下 3 个 P3 已全部修复（commit 见 git log "fix(traces)"），
> 每个配覆盖测试；闭环冒烟 + 400 路径现场复验通过。

### P3 [已修]: `POST /traces/hello` 在 tracing 禁用时返回全零假身份
- File: `packages/otel/src/trace.ts:55`（emitManualHelloSpan）+ `apps/backend/src/modules/traces/traces.service.ts:11`
- Trigger: `OTEL_EXPORTER_OTLP_ENDPOINT` 未设置（tracing disabled 路径）→ 全局 tracer 是 noop →
  `span.spanContext()` 返回 INVALID_SPAN_CONTEXT → 接口 200 返回
  `{"traceId":"00000000000000000000000000000000","spanId":"0000000000000000",...}`（全零恰好通过 32-hex regex）。
- Impact: 诊断端点给出看似合法、实际不存在的 trace 身份；使用者会拿它 GET 并困惑为什么查不到。
- Fix: service 层检测全零 traceId（`trace.isSpanContextValid` 或字符串比对），返回 503/明确错误体
  说明 tracing 未启用。低危：仅诊断端点、仅禁用路径。

### P3 [已修]: `GET /traces/:traceId` 无入参校验，畸形 id 返回违反契约的 200
- File: `apps/backend/src/modules/traces/traces.controller.ts:15`
- Trigger: `GET /traces/not-a-hex-id` → 直接进 ClickHouse 参数化查询（无注入风险）→ 空结果 →
  200 `{"traceId":"not-a-hex-id","spans":[]}`，而 `TraceDetailResponseSchema.traceId` 要求 32-hex，
  该响应本身不通过自家契约。
- Impact: 消费方（M9 前端）按契约 parse 会失败；当前无消费者，故 P3。
- Fix: controller 加 traceId 32-hex 校验（M2 引入 nestjs-zod ZodValidationPipe 时顺手收掉，
  或现在手写一行 regex → 400）。

### P3 [已修]: 冷库上 `GET /traces/:id` 会阻塞 10s 后 500
- File: `apps/backend/src/modules/traces/clickhouse-traces.repository.ts:60`（findByTraceId 每次调 ensureTraceViews）+ `:66-77`（waitForExporterTable 20×500ms）
- Trigger: ClickHouse 全新（collector 还没写过任何 span、`otel_traces` 不存在）时调 GET →
  轮询 20 次 × 500ms 后抛 Error → Nest 500，请求挂 10 秒。
- Impact: 边缘场景（fresh volume + 先读后写）体验差；正常流程（先 POST hello 再 GET）不受影响。
  另外 ensureTraceViews 每次读都执行 readFile + `CREATE VIEW IF NOT EXISTS` DDL，读路径多两次往返。
- Fix: 表不存在时快速返回空结果或 404（EXISTS 查一次、不轮询）；ensureTraceViews 成功后置
  进程内 flag 跳过后续重复执行。M9 做 trace UI 前建议处理。

## 未构成 finding、已核查排除的点

- VIEW 列名 / 类型：对照 0.130.1 exporter 实建表 DESCRIBE 逐列核过（N2），Duration ns→ms、
  nullIf(ParentSpanId)、kind fallback 均经 live 数据验证。
- SQL 注入：traceId 走 `{traceId:String}` query_params 参数绑定；`TRACE_VIEW_NAME` 是模块常量。
- 时区：toIsoUtc 按 UTC 显式解析（N3 已修）；纳秒截断到毫秒为有意行为。
- flush 降级：Collector 不可达时 hello 不再 500（6af7824 已修，带针对性单测）。
- 边界：lint 0；otel 不依赖 contracts/ClickHouse；contracts 无 OTLP 常量；conventions 零运行时依赖。
- 埋点不阻塞：endpoint 缺失 / collector 死端口两条降级路径均实测通过。

## Open Questions（非 finding）

1. postgres 端口仍发布在 `0.0.0.0:5432`（弱凭据 codecrush/codecrush）——M0 既有行为、不在本 diff 范围，
   但与本次 ClickHouse 收紧（a3816ae）逻辑一致，建议下波顺手改绑 127.0.0.1。
2. `dev`（`nest start --watch`）无 tracing 预加载——plan 明确接受（M0.5 只保证 built 路径确定性），
   记录以免后续误以为 dev 模式有 trace。
3. eslint 对 `otel-conventions` 禁了 `node:*` 前缀但未禁裸 `fs`/`path`——防护缺口无当前触发，
   依赖零 runtime deps 约束兜底。

## 结论

无 P1/P2。三个 P3（边缘路径小 bug）已在同日 fix 轮全部修复：
- 全零假身份 → service 拦截返回 503（traces.service.spec 覆盖）
- 畸形 traceId → controller 400（traces.controller.spec 覆盖，M2 换 ZodValidationPipe）
- 冷库 10s 挂起 → 表不存在快速返回空结果；viewsReady 缓存去掉重复 readFile/DDL（traces.repository.spec 覆盖）

复验：backend 10/10 tests、lint 0、observability:verify 通过、bad-id 现场 400。
