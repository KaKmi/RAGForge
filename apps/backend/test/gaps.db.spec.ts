/**
 * 迁移 0026（知识缺口/问题池三表）的 Postgres 集成测试（RUN_DB_TESTS=1 门控）。
 *
 * 钉住的四件事（021 决策 H / §10）：
 *  1. 三张表都建出来了；
 *  2. `status` CHECK 只放行 B2a 可达的三态——B2b 加四态时**必须 ALTER**，
 *     这条断言就是那个提醒（放行一个引擎不遵守的值 = 投机，同 eval_runs.scope 的既定约定）；
 *  3. `(cluster_id, source, source_trace_id)` 唯一——worker 崩溃重跑靠它幂等；
 *  4. pgvector 最近邻能按 cosine 取回预期簇（聚类归簇的地基）。
 *
 * ⛔ 只连 MIGRATION_TEST_DATABASE_URL（codecrush_mig_test）。开发库 codecrush 里是用户手工
 * 搭建、无备份的数据，本文件的 DROP SCHEMA 打到那上面就是永久丢失。
 */
import { readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";
import { dbGate } from "./helpers/gated-suite";

const describeDb = dbGate();
jest.setTimeout(180_000);

// 必须自包含：同套件里的迁移 spec 会 DROP SCHEMA public CASCADE，
// 依赖「库里已经迁好了」会出现「单跑绿、全套件红」。
const MIGRATIONS_DIR = join(__dirname, "..", "drizzle");

/** 1024 维向量字面量；维度已实测（chunks 全量 408 行均为 1024）。 */
function vec(fill: (i: number) => number): string {
  return `[${Array.from({ length: 1024 }, (_, i) => fill(i)).join(",")}]`;
}
const VEC_E0 = vec((i) => (i === 0 ? 1 : 0)); // 单位向量 e0
const VEC_E1 = vec((i) => (i === 1 ? 1 : 0)); // 单位向量 e1（与 e0 正交）

function journalTags(): string[] {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  return journal.entries.map((e) => e.tag);
}

async function applyMigrations(pool: Pool): Promise<void> {
  for (const tag of journalTags()) {
    const text = readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8");
    for (const raw of text.split("--> statement-breakpoint")) {
      const stmt = raw.trim();
      if (stmt) await pool.query(stmt);
    }
  }
}

async function resetSchema(pool: Pool): Promise<void> {
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
}

async function newCluster(pool: Pool, question: string, centroid: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO gap_clusters (representative_question, centroid) VALUES ($1, $2::vector) RETURNING id`,
    [question, centroid],
  );
  return rows[0].id;
}

/** 按 id 精确清理，绝不裸 delete 整表。 */
async function dropClusters(pool: Pool, ids: string[]): Promise<void> {
  await pool.query(`DELETE FROM gap_items WHERE cluster_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM gap_clusters WHERE id = ANY($1::uuid[])`, [ids]);
}

describeDb("0026 gap pool（RUN_DB_TESTS=1）", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.MIGRATION_TEST_DATABASE_URL });
    await resetSchema(pool);
    await applyMigrations(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("三张表都建出来了", async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('gap_clusters','gap_items','gap_watermarks')
       ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(["gap_clusters", "gap_items", "gap_watermarks"]);
  });

  it("status 只放行 B2a 可达的三态；B2b 的 drafting 等必须先 ALTER 才能用", async () => {
    for (const status of ["pending", "routed_retrieval", "ignored"]) {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO gap_clusters (representative_question, centroid, status)
         VALUES ('q', $1::vector, $2) RETURNING id`,
        [VEC_E0, status],
      );
      expect(rows[0].id).toBeTruthy();
      await dropClusters(pool, [rows[0].id]);
    }

    await expect(
      pool.query(
        `INSERT INTO gap_clusters (representative_question, centroid, status)
         VALUES ('q', $1::vector, 'drafting')`,
        [VEC_E0],
      ),
    ).rejects.toThrow(/gap_clusters_status_check/);
  });

  it("root_cause 两列各自受 CHECK 约束，且都可为空（worker 尚未分诊 / 人工未改判）", async () => {
    const id = await newCluster(pool, "q", VEC_E0);
    await pool.query(
      `UPDATE gap_clusters SET root_cause_auto = 'missing', root_cause_manual = 'retrieval' WHERE id = $1`,
      [id],
    );
    await expect(
      pool.query(`UPDATE gap_clusters SET root_cause_auto = 'nonsense' WHERE id = $1`, [id]),
    ).rejects.toThrow(/gap_clusters_root_cause_auto_check/);
    await dropClusters(pool, [id]);
  });

  it("一条 trace 全局只能入池一次（worker 重跑幂等的地基）", async () => {
    const id = await newCluster(pool, "能开专票吗", VEC_E0);
    const insert = () =>
      pool.query(
        `INSERT INTO gap_items (cluster_id, source, source_trace_id, question, embedding)
         VALUES ($1, 'online', 'trace-a', '能开专票吗', $2::vector)`,
        [id, VEC_E0],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/gap_items_source_trace_unique/);
    await dropClusters(pool, [id]);
  });

  it("**跨簇**也拦得住——这正是含 cluster_id 的键拦不住的那条路径", async () => {
    // 复现 peer review 指出的场景：worker 插入后、推进游标前崩溃；重跑时 centroid 已被
    // 其他 item 的增量平均挪动，同一条 trace 归到了**另一个**簇。
    // 若唯一键含 cluster_id，这里会插入成功 ⇒ 两簇各留一行、各 freq+1，且 freq 只增不减、无自愈。
    const a = await newCluster(pool, "簇A", VEC_E0);
    const b = await newCluster(pool, "簇B", VEC_E1);
    await pool.query(
      `INSERT INTO gap_items (cluster_id, source, source_trace_id, question, embedding)
       VALUES ($1, 'online', 'trace-dup', 'q', $2::vector)`,
      [a, VEC_E0],
    );
    await expect(
      pool.query(
        `INSERT INTO gap_items (cluster_id, source, source_trace_id, question, embedding)
         VALUES ($1, 'online', 'trace-dup', 'q', $2::vector)`,
        [b, VEC_E1],
      ),
    ).rejects.toThrow(/gap_items_source_trace_unique/);
    await dropClusters(pool, [a, b]);
  });

  it("**跨来源**也拦得住——手动入池命中冲突即「已在缺口中」，不再插一行（原型 :648）", async () => {
    const id = await newCluster(pool, "q", VEC_E0);
    await pool.query(
      `INSERT INTO gap_items (cluster_id, source, source_trace_id, question, embedding)
       VALUES ($1, 'online', 'trace-both', 'q', $2::vector)`,
      [id, VEC_E0],
    );
    await expect(
      pool.query(
        `INSERT INTO gap_items (cluster_id, source, source_trace_id, question, embedding)
         VALUES ($1, 'manual_trace', 'trace-both', 'q', $2::vector)`,
        [id, VEC_E0],
      ),
    ).rejects.toThrow(/gap_items_source_trace_unique/);
    await dropClusters(pool, [id]);
  });

  it("rewrite_resolved 默认 true、rewritten_question 可空（决策 F 的落库形状）", async () => {
    const id = await newCluster(pool, "q", VEC_E0);
    await pool.query(
      `INSERT INTO gap_items (cluster_id, source, source_trace_id, question, embedding)
       VALUES ($1, 'online', 'trace-b', '原问题', $2::vector)`,
      [id, VEC_E0],
    );
    const { rows } = await pool.query<{ rewrite_resolved: boolean; rewritten_question: string | null }>(
      `SELECT rewrite_resolved, rewritten_question FROM gap_items WHERE source_trace_id = 'trace-b'`,
    );
    expect(rows[0].rewrite_resolved).toBe(true);
    expect(rows[0].rewritten_question).toBeNull();
    await dropClusters(pool, [id]);
  });

  it("pgvector 按 cosine 取回最近簇，相似度可算", async () => {
    const near = await newCluster(pool, "近", VEC_E0);
    const far = await newCluster(pool, "远", VEC_E1);

    const { rows } = await pool.query<{ id: string; sim: string }>(
      `SELECT id, 1 - (centroid <=> $1::vector) AS sim
       FROM gap_clusters WHERE id = ANY($2::uuid[])
       ORDER BY centroid <=> $1::vector LIMIT 1`,
      [VEC_E0, [near, far]],
    );
    expect(rows[0].id).toBe(near);
    expect(Number(rows[0].sim)).toBeCloseTo(1, 5);

    // 正交向量的余弦相似度为 0，明显落在 0.85 阈值之下 —— 不该归为一簇。
    const { rows: orth } = await pool.query<{ sim: string }>(
      `SELECT 1 - (centroid <=> $1::vector) AS sim FROM gap_clusters WHERE id = $2`,
      [VEC_E0, far],
    );
    expect(Number(orth[0].sim)).toBeCloseTo(0, 5);

    await dropClusters(pool, [near, far]);
  });

  /**
   * 迁移 0027 的立论钉死在这里：`gap_watermarks.last_ts` 必须原样往返**纳秒**。
   *
   * 0026 曾把它建成 `timestamptz`，而游标比较的排序键是 ClickHouse 的 `DateTime64(9)`。
   * 经时间戳往返会被截断（列只到微秒，node-postgres 更是还原成 JS `Date` 只剩毫秒）：
   * `…123456789` 写回读出成 `…123000000` ⇒ 元组比较 `(123456789, id) > (123000000, id)`
   * 仍然成立 ⇒ **末行每轮被重新取出、游标永远推不过它**，收集器永久卡死在同一条 trace。
   *
   * ⚠️ 小数部分**必须非零且到第 9 位**：全零的小数（如隔离 spec 播种用的 `…00.000000000`）
   * 经 timestamptz 往返照样原样还原，**在原理上区分不出 0027 改没改**。
   * 有人 revert 0027 或把 schema 的 `lastTs` 改回 `timestamp`，本条会红。
   */
  it("last_ts 原样往返纳秒串（0027：游标绝不能经时间戳类型截断）", async () => {
    const raw = "2026-07-16 02:00:00.123456789";
    await pool.query(
      `INSERT INTO gap_watermarks (worker_name, last_ts, last_trace_id) VALUES ($1, $2, '')`,
      ["nanos-roundtrip", raw],
    );
    const { rows } = await pool.query<{ last_ts: string }>(
      `SELECT last_ts FROM gap_watermarks WHERE worker_name = $1`,
      ["nanos-roundtrip"],
    );
    expect(rows[0].last_ts).toBe(raw); // 逐字符相等，不是「约等于」
    // 按主键精确删自己的夹具（红线：禁止裸 delete/truncate 整表）。
    await pool.query(`DELETE FROM gap_watermarks WHERE worker_name = $1`, ["nanos-roundtrip"]);
  });
});
