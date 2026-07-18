#!/usr/bin/env node
/**
 * 门控套件的**用例数下限 + 零跳过**断言（review P2 第 3 条）。
 *
 * 背景：`test:db` / `test:infra` 里的每个 spec 都是「门控成立才 describe，否则 describe.skip」。
 * 门控一旦整体失效（最常见：`RUN_DB_TESTS` 被从 npm script 里删掉、`cross-env` 被换掉、
 * jest 参数被重构），**所有 suite 都变成 skip，jest 退出码仍是 0**，CI job 显示
 * 「9 suites 通过」而一条断言都没跑。`--passWithNoTests` 拦不住：skip ≠ no tests。
 *
 * `test/helpers/gated-suite.ts` 的硬门控守的是另一半（「要求跑」但「连接串缺失」）；
 * 本脚本守的是这一半（连「要求跑」都没了）。二者互补，都不可省。
 *
 * 断言四条：
 *  1. 无失败 suite / 失败用例（jest 退出码已管，这里是双保险，防 `|| true` 之类的吞码）；
 *  2. `numPendingTests === 0 && numTodoTests === 0` —— **静默跳过检测器**，本套件不允许
 *     任何 skip/todo（当前两个套件实测都是 0）；
 *  3. 通过的 suite 数 ≥ 基线；
 *  4. 通过的用例数 ≥ 基线 —— 把 AC2「test:db 用例数只增不减」从人工承诺变成机器检查。
 *
 * 基线只增不减：加了用例就把下面的数字调上去（调低需要在 PR 里说明理由）。
 */
import { readFileSync } from "node:fs";

/** 实测值（2026-07-18，docker infra 全绿）。新增用例后请上调。 */
const BASELINES = {
  db: { suites: 9, tests: 73, script: "test:db" },
  infra: { suites: 6, tests: 71, script: "test:infra" },
};

const [suiteKey, resultFile] = process.argv.slice(2);
const baseline = BASELINES[suiteKey];
if (!baseline) {
  console.error(
    `用法：node scripts/check-test-baseline.mjs <${Object.keys(BASELINES).join("|")}> <jest --outputFile 的路径>`,
  );
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(resultFile, "utf8"));
} catch (err) {
  console.error(`[基线断言] 读不到 jest 结果文件 ${resultFile}：${err.message}`);
  console.error("这本身就是一次门控失效——jest 没有写出 --outputFile，无从证明用例真的跑了。");
  process.exit(1);
}

const {
  numFailedTestSuites = 0,
  numFailedTests = 0,
  numPendingTests = 0,
  numTodoTests = 0,
  numPassedTestSuites = 0,
  numPassedTests = 0,
} = report;

const failures = [];
if (numFailedTestSuites > 0 || numFailedTests > 0) {
  failures.push(`有失败：${numFailedTestSuites} suites / ${numFailedTests} tests`);
}
if (numPendingTests > 0 || numTodoTests > 0) {
  failures.push(
    `存在被跳过的用例：pending=${numPendingTests}、todo=${numTodoTests}。` +
      `本套件的 spec 全是门控 spec，跳过 = 门控静默失效（真库/真 infra 断言一条没跑）。`,
  );
}
if (numPassedTestSuites < baseline.suites) {
  failures.push(`通过的 suite 数 ${numPassedTestSuites} < 基线 ${baseline.suites}`);
}
if (numPassedTests < baseline.tests) {
  failures.push(`通过的用例数 ${numPassedTests} < 基线 ${baseline.tests}`);
}

if (failures.length > 0) {
  console.error(`\n[基线断言失败] ${baseline.script}`);
  for (const line of failures) console.error(`  - ${line}`);
  console.error(
    `\n若是**有意**减少用例，请同步下调 scripts/check-test-baseline.mjs 的基线并在 PR 说明理由；` +
      `否则请检查门控环境变量（RUN_DB_TESTS / RUN_CLICKHOUSE_TESTS / MIGRATION_TEST_DATABASE_URL / CLICKHOUSE_URL）。\n`,
  );
  process.exit(1);
}

console.log(
  `[基线断言通过] ${baseline.script}: ${numPassedTestSuites} suites / ${numPassedTests} tests ` +
    `(基线 ${baseline.suites}/${baseline.tests}，跳过 0)`,
);
