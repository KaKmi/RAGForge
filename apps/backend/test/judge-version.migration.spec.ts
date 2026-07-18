import { readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";
import { dbGate } from "./helpers/gated-suite";

const describeDb = dbGate();
const MIGRATIONS_DIR = join(__dirname, "..", "drizzle");
const BASELINE_TAG = "0020_secret_nightmare";
const V2_TAG = "0021_judge_scoring_v2";
const BLOCKED = "judge scoring v2 migration blocked: queued or running eval_runs exist";

jest.setTimeout(180_000);

function journalTags(): string[] {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  return journal.entries.map((entry) => entry.tag);
}

async function applyMigration(pool: Pool, tag: string): Promise<void> {
  const text = readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8");
  for (const raw of text.split("--> statement-breakpoint")) {
    if (raw.trim()) await pool.query(raw.trim());
  }
}

async function resetAndMigrate(pool: Pool, stopTag: string): Promise<void> {
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  for (const tag of journalTags()) {
    await applyMigration(pool, tag);
    if (tag === stopTag) return;
  }
  throw new Error(`journal does not contain ${stopTag}`);
}

describeDb("judge scoring v2 migration", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.MIGRATION_TEST_DATABASE_URL });
  });

  beforeEach(async () => {
    await resetAndMigrate(pool, BASELINE_TAG);
    const setId = (
      await pool.query(
        `INSERT INTO eval_sets (name, created_by)
         VALUES ('judge-v2-migration','test') RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(`INSERT INTO online_eval_settings (id, judge_version) VALUES
      ('default','online-v1'), ('custom','tenant-v7')`);
    await pool.query(
      `INSERT INTO eval_runs
        (set_id, application_id, config_version_id, judge_model_id, embedding_model_id,
         offline_judge_version, status, case_version_snapshot, created_by)
       VALUES
        ($1,'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',
         '00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004',
         'offline-v1','done','[]','test'),
        ($1,'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',
         '00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004',
         'offline-v1','running','[]','test')`,
      [setId],
    );
  });

  afterAll(async () => pool?.end());

  it("blocks active v1 runs, then upgrades defaults without rewriting history", async () => {
    await expect(applyMigration(pool, V2_TAG)).rejects.toThrow(BLOCKED);
    expect(
      (await pool.query(`SELECT judge_version FROM online_eval_settings WHERE id='default'`))
        .rows[0].judge_version,
    ).toBe("online-v1");

    await pool.query(`UPDATE eval_runs SET status='failed' WHERE status IN ('queued','running')`);
    await applyMigration(pool, V2_TAG);

    expect(
      (await pool.query(`SELECT id, judge_version FROM online_eval_settings ORDER BY id`)).rows,
    ).toEqual([
      { id: "custom", judge_version: "tenant-v7" },
      { id: "default", judge_version: "online-v2" },
    ]);
    expect(
      (await pool.query(`SELECT DISTINCT offline_judge_version FROM eval_runs ORDER BY 1`)).rows,
    ).toEqual([{ offline_judge_version: "offline-v1" }]);
    const defaults = await pool.query(`SELECT table_name, column_default
      FROM information_schema.columns
      WHERE table_schema='public' AND
        ((table_name='online_eval_settings' AND column_name='judge_version') OR
         (table_name='eval_runs' AND column_name='offline_judge_version'))
      ORDER BY table_name`);
    expect(defaults.rows.map((row) => row.column_default)).toEqual([
      "'offline-v2'::character varying",
      "'online-v2'::character varying",
    ]);
  });
});
