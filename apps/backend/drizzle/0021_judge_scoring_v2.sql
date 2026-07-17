DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM eval_runs WHERE status IN ('queued', 'running')) THEN
    RAISE EXCEPTION 'judge scoring v2 migration blocked: queued or running eval_runs exist';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "online_eval_settings" ALTER COLUMN "judge_version" SET DEFAULT 'online-v2';--> statement-breakpoint
ALTER TABLE "eval_runs" ALTER COLUMN "offline_judge_version" SET DEFAULT 'offline-v2';--> statement-breakpoint
UPDATE online_eval_settings SET judge_version='online-v2' WHERE judge_version='online-v1';
