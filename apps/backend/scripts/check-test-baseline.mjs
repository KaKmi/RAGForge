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

/**
 * 两个基线现在**都是实测值**（2026-07-19，本机 docker infra：postgres + clickhouse +
 * otel-collector 全 healthy，两个套件各跑一次全绿、跳过 0）：
 *
 *   - `test:db`   —— 11 suites / 82 tests（2026-07-18 首测，2026-07-19 复测一致）。
 *   - `test:infra` —— 7 suites / 91 tests（2026-07-19 **首次实测**；首跑 88 passed / 3 failed，
 *     修复夹具后复跑 91 全绿，此处记的是修复后的值）。
 *
 * infra 这一行此前是**推算值**（起点 71 + 本波新增，见 git history）。本轮 docker 恢复后
 * 实测总数与推算值恰好吻合（91 = 91），推算过程因此作废、不再保留——数字已由实测背书。
 *
 * ⚠️ 但「总数吻合」恰恰掩盖了问题：首次实测同时暴露了 3 条**从未真正跑过**的断言
 * （manual-score.e2e.spec.ts）——夹具的根 span 漏了 `codecrush.span.kind: "chain"`，
 * trace 进不了 `codecrush_traces` 视图，作业直接落 failed，裁判一次没被调到。
 * 教训写在这里而不是只写在 commit 里：**推算出来的用例数只能证明「数量对得上」，
 * 证明不了「断言真的执行过」**——门控套件长期跑不起来时，这道下限守卫是失效的，
 * 别把它当作覆盖率的证据。
 */
const BASELINES = {
  // db：B2a 加 test/gaps.db.spec.ts（8 条）后**实测** 12 suites / 90 tests。
  // 断言是 `>=`，所以基线必须写**实测值**而不是估算：写低 1 就等于给「第一条用例悄悄消失」放行
  // ——本波初版正是估成 87（实测 88），被 peer review 抓出，随后又因补两条跨簇/跨来源用例变 90。
  // Task 5 又加 1 条（last_ts 纳秒往返，钉死迁移 0027）⇒ 12/91。
  // Task 6 加 test/gaps.service.db.spec.ts（peer review 后补到 25 条）⇒ 13/116。
  // B2b：gaps.db 补 fill_* 列用例、gaps.service.db 补四态迁移与质心 CAS 共 33 条，
  // 再加 test/eval-run-ignore.db.spec.ts（5 条，钉死「标记忽略」的 caseId→caseVersionId 桥接
  // ——那个坑内存 fake 与前端测试都抓不住，只有真库里两个真实 UUID 才分得开）⇒ **实测** 14/157。
  // B2b 收尾：补 2 条 CAS（原来那条「并发」用例被证明是空测——两个 Promise 实际串行、
  // 撞的是内存守卫抛 400，ConflictException 从没触发）+ 4 条 terminal_at 写入
  // （改成恒 null 时 238 测试全绿，而它是迁移 0029 的全部理由）⇒ **实测** 14/163。
  db: { suites: 14, tests: 166, script: "test:db" },
  // infra：B2a Task 5 加 test/gap-pool-isolation.spec.ts（5 条）后 8 suites / 96 tests；
  // Task 6 再加 test/gaps.e2e.spec.ts（10 条 HTTP 全链路）⇒ 9 suites / 106 tests。
  // B2b e2e 阶段：gaps.e2e 追加「补知识库向导」6 条（三步走通 / 两条红线 / 取消保留草稿 /
  // 草拟失败退回 / 非 UUID 400）⇒ **实测** 9 suites / 112 tests。
  // 其中「跳过人审直接 submit ⇒ 400 且 uploads 为空」已用变异测试验过：
  // 把 upload 前的状态守卫改成恒假，该条立刻变红——它钉的正是本波唯一的产品红线。
  infra: { suites: 9, tests: 116, script: "test:infra" },
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
