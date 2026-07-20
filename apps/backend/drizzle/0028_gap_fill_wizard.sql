-- B2b Task 1：缺口状态机四态 + [补知识库] 向导/回验所需的列 + 屏3「标记忽略」字段。
--
-- ① 状态机四态（021 决策 J）。0026 建 CHECK 时只放行 B2a 可达的三态，并在
--    `schema.ts:54-56` 与 `eval-runs/schema.ts:173-175` 两处注明「B2b 加四态时必须 ALTER 此 CHECK」。
--    这就是那次兑现。用 varchar+CHECK 而非 PG enum 正为此：ALTER CHECK 不改类型、不锁表重写。
ALTER TABLE "gap_clusters" DROP CONSTRAINT "gap_clusters_status_check";
--> statement-breakpoint
ALTER TABLE "gap_clusters" ADD CONSTRAINT "gap_clusters_status_check"
  CHECK ("status" IN ('pending','routed_retrieval','ignored','drafting','reviewing','filled','verified'));
--> statement-breakpoint

-- ② 向导与回验的载荷列（021 决策 K）。全部 nullable、纯附加：
--    pending/ignored/routed_retrieval 状态下恒 NULL，对既有行零影响。
--
--    `fill_pre_score` 必须在点 [补知识库] 那一刻快照，**不能**展示时再读 `avg_quality`——
--    后者是对 gap_items 的实时聚合（`gaps.repository.ts` 的 selectClusterRows），而向导从点击到
--    入库完成回验可能跨越数分钟到下一个收集器周期（GAP_COLLECT_CRON = */30），
--    现读会让「41→89」里的 41 随新坏样本涌入而静默漂移，不再是用户当时看到的数。
--
--    不新建 `gap_fill_jobs` 独立表：当前约束是「一个簇同时至多一个进行中的补库流程」，
--    加列比加表更符合 021「不要投机」的既定原则（同决策 H 对 gap_watermarks 的取舍）。
ALTER TABLE "gap_clusters"
  ADD COLUMN "fill_draft_question" varchar(200),
  ADD COLUMN "fill_draft_answer" text,
  ADD COLUMN "fill_target_kb_id" uuid,
  ADD COLUMN "fill_target_document_id" uuid,
  ADD COLUMN "fill_verify_application_id" uuid,
  ADD COLUMN "fill_verify_config_version_id" uuid,
  ADD COLUMN "fill_pre_score" smallint,
  ADD COLUMN "verified_score" smallint,
  ADD COLUMN "recurred_at" timestamp with time zone;
--> statement-breakpoint

-- ③ 分数列的 0-100 兜底，与同表 `gap_items_scores_check` 及 eval-runs 侧同域约定一致。
--    NULL 不受 CHECK 约束（NULL → unknown → 通过），故「未评/未回验记 NULL」不受影响。
ALTER TABLE "gap_clusters" ADD CONSTRAINT "gap_clusters_fill_scores_check"
  CHECK (("fill_pre_score" IS NULL OR "fill_pre_score" BETWEEN 0 AND 100)
     AND ("verified_score" IS NULL OR "verified_score" BETWEEN 0 AND 100));
--> statement-breakpoint

-- ④ 回验监听器按 fill_target_document_id 反查「哪个 filled 簇在等这份文档」（Task 8 的
--    GapVerificationNotifier）。文档 ready 事件是 fan-out 广播，每次都会走这条查询，建索引。
--    partial index：只有真正提交过入库的行才有值，绝大多数行是 NULL 不必入索引。
CREATE INDEX IF NOT EXISTS "gap_clusters_fill_document_idx"
  ON "gap_clusters" ("fill_target_document_id")
  WHERE "fill_target_document_id" IS NOT NULL;
--> statement-breakpoint

-- ⑤ 屏3「标记忽略」（021 决策 L）。B2a 明令不改 eval-runs schema，故延后到本波。
--    叠加标志（时间戳而非排他状态，同 gap_clusters.entered_eval_set_at 的既定风格）：
--    忽略的行仍保留原 verdict 与全部分数，只影响默认视图筛选，不改任何既有分数计算。
--    纯附加列，既有 SELECT 全部显式点列名（无 SELECT *），零影响。
ALTER TABLE "eval_run_results" ADD COLUMN "ignored_at" timestamp with time zone;
