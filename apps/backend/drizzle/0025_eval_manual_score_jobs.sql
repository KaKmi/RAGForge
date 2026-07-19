-- B1/F3：「立即评测」是人工触发的旁路，需要自己的作业表。
--
-- 为什么不复用 eval_candidate_ledger：那张表的主键同样是 (target_trace_id, judge_version)，
-- 写进去会与周期 worker 的行**主键冲突**——worker 的 upsert 会 seen_count+1 并覆盖 outcome，
-- 把人工触发伪装成一次游标扫描；且 countLedgerByOutcome 不按 worker_name 过滤，
-- 人工行会污染屏1 的 missed/scoresNotPersisted 口径。账本记的是**游标推进**语义，
-- 人工触发不推进游标，按其既定判据就不该进账本。
CREATE TABLE "eval_manual_score_jobs" (
  "target_trace_id" varchar(32) NOT NULL,
  "judge_version" varchar(100) NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'queued',
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "requested_by" varchar(200) NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "eval_manual_score_jobs_pk" PRIMARY KEY ("target_trace_id","judge_version"),
  CONSTRAINT "eval_manual_score_jobs_status_check"
    CHECK ("status" IN ('queued','running','scored','failed'))
);
--> statement-breakpoint
CREATE INDEX "eval_manual_score_jobs_status_idx"
  ON "eval_manual_score_jobs" ("status","updated_at");
