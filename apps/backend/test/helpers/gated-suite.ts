/**
 * 门控 spec 的**硬门控**（review P2：「守护网自己没有守护网」）。
 *
 * 所有真库 / 真 infra spec 的形状都是
 * `RUN_DB_TESTS === "1" && !!MIGRATION_TEST_DATABASE_URL ? describe : describe.skip`。
 * 这个形状在本地是对的（`pnpm test` 不该被真库依赖绊住），在 CI 里却是个**假绿制造机**：
 * 门控条件只要有一半不成立就整体 `describe.skip` —— jest **退出码 0**、job 显示
 * 「9 suites 通过」，而**一条断言都没执行**。`--passWithNoTests` 拦不住：skip ≠ no tests。
 *
 * 这正是本仓库当初立项 CI 门控那一波要根治的失败模式（`eval-runs.lease.db.spec.ts:25-27`：
 * 「此前它不在任何脚本里 → describe.skip 静默跳过 → 钉子自己从不执行」），只是被原样搬到了
 * 上一层：任何一次把 `MIGRATION_TEST_DATABASE_URL` 从 job env 上删掉 / 改名 / 拼错 /
 * 提到错误 YAML 层级的编辑（重构 workflow、抽 composite action、迁到 matrix），都会让 CI 假绿。
 *
 * 对策分两层，缺一不可：
 *  1. **本文件**：CI 里一旦「被要求跑」（`RUN_*=1`）却「连接串缺失」，**直接抛错**让 suite 变红，
 *     而不是静默跳过。本地（无 `CI`）保持原有 skip 语义不变。
 *  2. `scripts/check-test-baseline.mjs`：兜住第 1 层够不着的那半边 —— `RUN_*` 本身被删
 *     （于是「没被要求跑」，不触发抛错）导致整批静默跳过。它断言用例数不低于基线、
 *     且 `numPendingTests === 0`。
 *
 * workflow 侧还有第三道（`test -n "$MIGRATION_TEST_DATABASE_URL"`），在装依赖之前就失败，
 * 省掉一整轮 20 分钟的 job。三道互不替代：1 守 spec、2 守脚本、3 守 workflow。
 */

type DescribeFn = typeof describe;

/** GitHub Actions / 多数 CI 都设 `CI=true`；`"1"` 一并接受。 */
function isCi(): boolean {
  return process.env.CI === "true" || process.env.CI === "1";
}

/**
 * 「被要求跑」+「CI」+「缺变量」= 抛错。其余情况一律沉默（返回即可）。
 *
 * 注意抛在**模块顶层**（各 spec 调用点在 import 之后、describe 之前），jest 会把整个
 * suite 记成 failed 并打印本错误 —— 这就是我们要的「响亮地红」。
 */
function requireEnvInCi(requested: boolean, vars: readonly string[]): void {
  if (!requested || !isCi()) return;
  const missing = vars.filter((name) => !process.env[name]);
  if (missing.length === 0) return;
  throw new Error(
    `[CI 硬门控] 本 spec 已被要求在 CI 中运行（RUN_* 已置位），但缺少环境变量：` +
      `${missing.join(", ")}。\n` +
      `缺失时的旧行为是 describe.skip —— jest 退出码 0、job 变绿而一条断言都没跑，` +
      `正是本门控要杜绝的假绿。\n` +
      `修复：在 .github/workflows/ci.yml 对应 job 的 env 下补齐该变量` +
      `（本地跑请自行 export，见 test/helpers/gated-suite.ts 注释）。`,
  );
}

/** 真 Postgres：`RUN_DB_TESTS=1` + `MIGRATION_TEST_DATABASE_URL`（`pnpm test:db`）。 */
export function dbGate(): DescribeFn {
  const requested = process.env.RUN_DB_TESTS === "1";
  requireEnvInCi(requested, ["MIGRATION_TEST_DATABASE_URL"]);
  return requested && !!process.env.MIGRATION_TEST_DATABASE_URL ? describe : describe.skip;
}

/** 真 PG + 真 ClickHouse 的 e2e：三个门控齐备才跑（`pnpm test:infra`）。 */
export function infraGate(): DescribeFn {
  const requested =
    process.env.RUN_DB_TESTS === "1" && process.env.RUN_CLICKHOUSE_TESTS === "1";
  requireEnvInCi(requested, ["MIGRATION_TEST_DATABASE_URL", "CLICKHOUSE_URL"]);
  return requested && !!process.env.MIGRATION_TEST_DATABASE_URL ? describe : describe.skip;
}

/**
 * 纯 ClickHouse：`RUN_CLICKHOUSE_TESTS=1`。
 *
 * `CLICKHOUSE_URL` 在调用点有 `?? "http://localhost:8123"` 兜底，本地可省；但在 CI 里
 * 「悄悄回落到 localhost」与「悄悄跳过」是同一类隐性降级 —— 服务地址一旦从 job env 掉了，
 * 我们要的是红，不是连到一个碰巧存在的 localhost。故 CI 里仍强制要求。
 */
export function clickHouseGate(): DescribeFn {
  const requested = process.env.RUN_CLICKHOUSE_TESTS === "1";
  requireEnvInCi(requested, ["CLICKHOUSE_URL"]);
  return requested ? describe : describe.skip;
}
