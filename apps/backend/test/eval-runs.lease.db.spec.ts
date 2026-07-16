import { readFileSync } from "fs";
import { join } from "path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { EvalRunsRepository } from "../src/modules/eval-runs/eval-runs.repository";
import {
  EVAL_RUN_LEASE_MS,
  EVAL_RUN_REAP_GRACE_MS,
} from "../src/modules/eval-runs/eval-run.constants";

/**
 * **真库**租约/回收语义（`RUN_DB_TESTS=1` + `MIGRATION_TEST_DATABASE_URL` 时才跑，
 * 形状同 `conversations.evaluation-turn.spec.ts`）。
 *
 * 为什么必须打真库：本文件守的每一条都是 **SQL 三值逻辑**上的性质，fake 复刻不出来 ——
 * peer review 实测过三次：
 *  ① 首版 fake 忠实地复刻了 `lease_until = NULL` 的 BUG，于是「测试与 bug 一起绿」；
 *  ② 把 `releaseLease` 的 `leaseUntil: now` 改回 `null`（= 完整回退那个 P1），
 *    全量 875 条单测**仍然全绿** —— 因为 worker spec 的 `releaseLease()` 是个空 fake。
 *  ③ `1bb8b13` 引入「持租的 run 被回收 → `markRunning` 复活成 running+NULL 租约 →
 *    两条回收臂都够不着 → 永久 409」这条死锁时，本文件当时的 12 条**也全绿**（review 第 2 轮
 *    P2）—— 因为没有一条断言去看「租约活着时回收器该让路」。
 * 即：这个修复此前可以被无声回退而 CI 毫无反应。本文件就是钉死它的那颗钉子。
 *
 * ⚠️ **跑法：`pnpm --filter @codecrush/backend test:db`**（2026-07-16 起本文件已挂进该脚本；
 * 此前它不在任何脚本里 —— `pnpm test` 无 `RUN_DB_TESTS` → `describe.skip` **静默跳过**，
 * `test:db` 又只点名 `prompts.migration.spec.ts`，于是上面这颗「钉子」自己从不执行）。
 * 该脚本必须 `--runInBand`：本文件与其余 db spec 都对**同一个** `MIGRATION_TEST_DATABASE_URL`
 * 执行 `DROP SCHEMA public CASCADE`，并行跑会互相拆台（实测：并行时 5 个 suite 全部
 * 死于 `schema "public" does not exist`）。
 */

const enabled = process.env.RUN_DB_TESTS === "1" && !!process.env.MIGRATION_TEST_DATABASE_URL;
const describeDb = enabled ? describe : describe.skip;
const migrationsDir = join(__dirname, "..", "drizzle");
jest.setTimeout(180_000);

async function resetAndMigrate(pool: Pool): Promise<void> {
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  const journal = JSON.parse(
    readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };
  for (const { tag } of journal.entries) {
    const sql = readFileSync(join(migrationsDir, `${tag}.sql`), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) await pool.query(statement.trim());
    }
  }
}

const ID = "11111111-1111-4111-8111-111111111111";

describeDb("eval run lease + reaper（真库三值逻辑）", () => {
  let pool: Pool;
  let repo: EvalRunsRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.MIGRATION_TEST_DATABASE_URL });
    await resetAndMigrate(pool);
    repo = new EvalRunsRepository(drizzle(pool) as never);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM eval_run_results");
    await pool.query("DELETE FROM eval_runs");
    await pool.query("DELETE FROM eval_sets");
    await pool.query(`INSERT INTO eval_sets (id, name, created_by) VALUES ($1, 'set', 't')`, [ID]);
  });

  /** `createdAt` 省略 = now（默认值）；queued 孤儿的判据是**创建时刻**，故必须可控。 */
  async function insertRun(
    status: string,
    leaseOwner: string | null,
    leaseUntil: Date | null,
    createdAt?: Date,
  ) {
    const rows = await pool.query(
      `INSERT INTO eval_runs (set_id, application_id, config_version_id, judge_model_id,
         embedding_model_id, case_version_snapshot, created_by, status, lease_owner, lease_until,
         created_at)
       VALUES ($1,$1,$1,$1,$1,'[]'::jsonb,'t',$2,$3,$4,COALESCE($5::timestamptz, now())) RETURNING id`,
      [ID, status, leaseOwner, leaseUntil, createdAt ?? null],
    );
    return rows.rows[0].id as string;
  }

  const statusOf = async (id: string) =>
    (
      await pool.query(
        `SELECT status, lease_owner, lease_until, error FROM eval_runs WHERE id=$1`,
        [id],
      )
    ).rows[0];

  const ago = (ms: number) => new Date(Date.now() - ms);

  it("releaseLease 留下**已过期时间戳**而非 NULL —— 回收器赖以判断的证据不能被抹掉", async () => {
    const id = await insertRun("running", "w1", new Date(Date.now() + EVAL_RUN_LEASE_MS));
    await repo.releaseLease(id, "w1");
    const row = await statusOf(id);
    // 这一条就是那个 P1 的钉子：置 NULL 的话，下面的回收器永远看不见这条 run
    // （SQL 里 `NULL < ts` 求值为 NULL 而非 TRUE），run 永久卡 running → 功能死锁。
    expect(row.lease_until).not.toBeNull();
    expect(row.lease_owner).toBeNull();
  });

  it("未捕获异常路径（release 后超过宽限期）→ 被回收成 failed，死锁解除", async () => {
    const id = await insertRun("running", null, ago(EVAL_RUN_REAP_GRACE_MS + 60_000));
    expect(await repo.reapAbandonedRuns(new Date())).toEqual([id]);
    const row = await statusOf(id);
    expect(row.status).toBe("failed");
    // owner 必须一并清掉：否则被误回收的 worker 续租仍成功 → 不让位 → 把结果写进 failed run
    expect(row.lease_owner).toBeNull();
    // running 僵尸保留原文案（CASE 的 ELSE 分支）—— 两类死因不可混同。
    expect(row.error).toBe("评测执行异常中断（worker 未在租约内续期）");
  });

  it("刚 release、pg-boss 正要重试（宽限期内）→ **不**回收，retryLimit:3 不被架空", async () => {
    const id = await insertRun("running", null, new Date());
    expect(await repo.reapAbandonedRuns(new Date())).toEqual([]);
    expect((await statusOf(id)).status).toBe("running");
  });

  // ⚠️ 本条原为「queued 的 run 永不被回收」，用 `now + 1000*GRACE` 断言「无论过多久都不回收」。
  // 那个断言把 P2 缺陷钉成了预期：它只观察到**健康**排队 run（几秒内就会被 worker 取走并
  // markRunning）不该被回收，却把结论过度外推成「任何 queued 都不回收」，从而掩盖了
  // 「job 已消失的 queued 孤儿」。此处收窄为它真正想守的性质（**宽限期内**不回收），
  // 下面三条补上它推不出的那一半。断言未被削弱：净增 3 条更强的断言。
  it("**新鲜** queued run（宽限期内）不被回收 —— 排队中不是僵尸", async () => {
    const id = await insertRun("queued", null, null);
    expect(await repo.reapAbandonedRuns(new Date())).toEqual([]);
    expect((await statusOf(id)).status).toBe("queued");
  });

  // ——— P2：queued 孤儿（job 再也不会来）——————————————————————————————
  // 两条可达路径终态不同，必须分别钉死：lease_until 是 NULL 还是过期时间戳。

  it("queued 孤儿（insertRun 后 publish 前进程被杀 → 无 job、无租约）超宽限期 → 回收成 failed", async () => {
    // 租约恒 NULL：没有任何 worker 碰过它 → 判据只能是 created_at。
    const id = await insertRun("queued", null, null, ago(EVAL_RUN_REAP_GRACE_MS + 60_000));
    expect(await repo.reapAbandonedRuns(new Date())).toEqual([id]);
    const row = await statusOf(id);
    expect(row.status).toBe("failed");
    // 死因要说实话：queued 孤儿是「压根没启动」，不是「跑到一半 worker 没了」。
    // 该 CASE 表达式读的是**更新前**的 status —— 这条断言同时钉死那个前提。
    // 文案只陈述观察得到的事实（无人接管），不断言「任务已丢失」—— 回收器判不出 job 是丢了
    // 还是还在队列里干等，后者在 backend 宕机 > GRACE 后重启时真实可达。
    expect(row.error).toBe("评测未能启动（超过宽限期仍无 worker 接管，可重新发起）");
  });

  it("queued 孤儿（markRunning 前瞬时 DB 错误、重试耗尽 → release 留下过期租约）→ 回收成 failed", async () => {
    // tryAcquireLease 成功但 markRunning 前就抛 → finally 的 releaseLease 留下
    // `lease_owner=NULL, lease_until=<过去>`，而 status 仍是 queued（从未 markRunning）。
    const stale = ago(EVAL_RUN_REAP_GRACE_MS + 60_000);
    const id = await insertRun("queued", null, stale, stale);
    expect(await repo.reapAbandonedRuns(new Date())).toEqual([id]);
    expect((await statusOf(id)).status).toBe("failed");
  });

  it("回收 queued 孤儿后 findActiveRun 放行 —— 全局串行位真的释放（P2 的用户可见性质）", async () => {
    // 这才是 P2 的要害：孤儿占着 ACTIVE_STATUSES 里的唯一槽位 → 此后每次 POST /eval/runs 恒 409。
    const id = await insertRun("queued", null, null, ago(EVAL_RUN_REAP_GRACE_MS + 60_000));
    expect((await repo.findActiveRun())?.id).toBe(id); // 死锁存在
    await repo.reapAbandonedRuns(new Date());
    expect(await repo.findActiveRun()).toBeUndefined(); // 死锁解除
  });

  // ——— 不变量：持租即免疫 / 失租不可复活 ————————————————————————————
  // 上面三条把「job 已消失的 queued 孤儿要被回收」钉死了，但**只按 created_at 判**会连
  // 「job 还活着、worker 刚接管」的 queued run 一起杀掉 —— 二者在 created_at 上长得一模一样。
  // 判据必须同时看**租约证据**：`created_at` 说「排队很久了」，租约说「有没有人正在管它」。
  //
  // 可达前提（无需毫秒级竞态）：backend 宕机/部署 > GRACE，job 在 pg-boss 里持久化于 PG，
  // 进程回来后照常被取走 → 一条 created_at 远早于 GRACE、但 job 完好的 queued run。
  // 此时 worker 的 `tryAcquireLease` → `findRunById` → `resolveForTest` → `markRunning`
  // 之间有真实窗口，而任一 `POST /eval/runs` 都会在 `findActiveRun` 守卫**之前**触发回收器
  // （`eval-runs.service.ts:172`，连注定 409 的请求也触发）。

  it("持租的 queued run（worker 刚抢到租约、正要 markRunning）不被回收 —— 持租即免疫", async () => {
    const id = await insertRun("queued", null, null, ago(EVAL_RUN_REAP_GRACE_MS + 60_000));
    // worker 取到 job，原子接管：租约推到未来。这就是「job 还活着」的证据。
    expect(await repo.tryAcquireLease(id, "w1", new Date(), EVAL_RUN_LEASE_MS)).toBe(true);

    expect(await repo.reapAbandonedRuns(new Date())).toEqual([]);
    const row = await statusOf(id);
    expect(row.status).toBe("queued");
    expect(row.lease_owner).toBe("w1"); // 接管未被抹掉
  });

  it("被回收的 run 不能被 markRunning 复活 —— 失去租约者永不能写回 running", async () => {
    // 真孤儿（无人持租）→ 理应被回收。
    const id = await insertRun("queued", null, null, ago(EVAL_RUN_REAP_GRACE_MS + 60_000));
    expect(await repo.reapAbandonedRuns(new Date())).toEqual([id]);

    // worker 在回收**之前**读到的是 queued，随后照常走到 markRunning。回收器已清空 owner，
    // 故这一步必须是 no-op —— 否则它把一条 failed run 写回 running 且租约为 NULL。
    expect(await repo.markRunning(id, "w1", new Date())).toBe(false);
    expect((await statusOf(id)).status).toBe("failed");
  });

  it("持租者的 markRunning 照常生效（守卫不能误伤正常路径）", async () => {
    const id = await insertRun("queued", null, null);
    const now = new Date();
    expect(await repo.tryAcquireLease(id, "w1", now, EVAL_RUN_LEASE_MS)).toBe(true);
    expect(await repo.markRunning(id, "w1", now)).toBe(true);
    expect((await statusOf(id)).status).toBe("running");
  });

  it("活 worker 持租 → 并发回收 → markRunning：终态绝不是「running + 无主租约」那个不可回收的死锁", async () => {
    const id = await insertRun("queued", null, null, ago(EVAL_RUN_REAP_GRACE_MS + 60_000));
    await repo.tryAcquireLease(id, "w1", new Date(), EVAL_RUN_LEASE_MS); // worker 接管
    await repo.reapAbandonedRuns(new Date()); // 并发 POST /eval/runs 触发回收
    await repo.markRunning(id, "w1", new Date()); // worker 继续推进

    const row = await statusOf(id);
    // `running` + `lease_until IS NULL` 是**两条回收臂都够不着**的终局：running 臂要
    // `lease_until < deadline`（`NULL < ts` 求值为 NULL 而非 TRUE），queued 臂要 status='queued'。
    // 一旦落进去，findActiveRun 恒返回它 → POST /eval/runs 恒 409 → 只能人工改库。
    expect({ status: row.status, leaseNull: row.lease_until === null }).not.toEqual({
      status: "running",
      leaseNull: true,
    });

    // 活性：无论上面谁赢，槽位最终都必须能被释放（回收器够得着，或已是终态）。
    if (row.status === "queued" || row.status === "running") {
      const far = new Date(Date.now() + 100 * EVAL_RUN_REAP_GRACE_MS);
      expect(await repo.reapAbandonedRuns(far)).toEqual([id]);
    }
    expect(await repo.findActiveRun()).toBeUndefined();
  });

  it("健康 run（租约在未来）不被回收", async () => {
    const id = await insertRun("running", "w1", new Date(Date.now() + EVAL_RUN_LEASE_MS));
    expect(await repo.reapAbandonedRuns(new Date())).toEqual([]);
    expect((await statusOf(id)).status).toBe("running");
  });

  it("终态 run 不被回收（只认 running）", async () => {
    const id = await insertRun("done", null, ago(EVAL_RUN_REAP_GRACE_MS + 60_000));
    expect(await repo.reapAbandonedRuns(new Date())).toEqual([]);
    expect((await statusOf(id)).status).toBe("done");
  });

  it("被回收后 renewLease 返回 false —— worker 据此立刻让位", async () => {
    const id = await insertRun("running", "w1", ago(EVAL_RUN_REAP_GRACE_MS + 60_000));
    await repo.reapAbandonedRuns(new Date());
    expect(await repo.renewLease(id, "w1", new Date(), EVAL_RUN_LEASE_MS)).toBe(false);
  });

  it("release 后重试能立刻重新抢到租约（宽限期不挡重试）", async () => {
    const id = await insertRun("running", "w1", new Date(Date.now() + EVAL_RUN_LEASE_MS));
    await repo.releaseLease(id, "w1");
    // 新 owner（重试是新的 randomUUID）必须能立刻抢到，否则重试要干等一个 TTL。
    expect(await repo.tryAcquireLease(id, "w2", new Date(Date.now() + 1), EVAL_RUN_LEASE_MS)).toBe(
      true,
    );
  });

  it("他人持有且未过期的租约抢不到（全局串行的第二道保险）", async () => {
    const id = await insertRun("running", "w1", new Date(Date.now() + EVAL_RUN_LEASE_MS));
    expect(await repo.tryAcquireLease(id, "w2", new Date(), EVAL_RUN_LEASE_MS)).toBe(false);
  });
});
