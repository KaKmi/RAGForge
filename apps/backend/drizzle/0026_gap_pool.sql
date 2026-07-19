CREATE TABLE IF NOT EXISTS "gap_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"representative_question" varchar(500) NOT NULL,
	"centroid" vector(1024) NOT NULL,
	"freq" integer DEFAULT 0 NOT NULL,
	"status" varchar(30) DEFAULT 'pending' NOT NULL,
	"root_cause_auto" varchar(20),
	"root_cause_manual" varchar(20),
	"entered_eval_set_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "gap_clusters_status_check" CHECK ("status" IN ('pending','routed_retrieval','ignored')),
	CONSTRAINT "gap_clusters_root_cause_auto_check" CHECK ("root_cause_auto" IS NULL OR "root_cause_auto" IN ('missing','retrieval','generation')),
	CONSTRAINT "gap_clusters_root_cause_manual_check" CHECK ("root_cause_manual" IS NULL OR "root_cause_manual" IN ('missing','retrieval','generation'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gap_clusters_centroid_hnsw_idx" ON "gap_clusters" USING hnsw ("centroid" vector_cosine_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gap_clusters_status_freq_idx" ON "gap_clusters" ("status","freq" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gap_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_id" uuid NOT NULL REFERENCES "gap_clusters"("id"),
	"source" varchar(20) NOT NULL,
	"source_trace_id" varchar(32) NOT NULL,
	"question" varchar(500) NOT NULL,
	"rewritten_question" varchar(500),
	"rewrite_resolved" boolean DEFAULT true NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"trace_start_time" timestamp with time zone,
	"faithfulness" smallint,
	"answer_relevancy" smallint,
	"context_precision" smallint,
	"confidence" smallint,
	"fallback_used" boolean DEFAULT false NOT NULL,
	"no_citations" boolean DEFAULT false NOT NULL,
	"follow_up_suspected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gap_items_source_check" CHECK ("source" IN ('online','manual_trace','offline_run')),
	CONSTRAINT "gap_items_scores_check" CHECK (
		("faithfulness" IS NULL OR "faithfulness" BETWEEN 0 AND 100)
		AND ("answer_relevancy" IS NULL OR "answer_relevancy" BETWEEN 0 AND 100)
		AND ("context_precision" IS NULL OR "context_precision" BETWEEN 0 AND 100)
		AND ("confidence" IS NULL OR "confidence" BETWEEN 0 AND 100)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gap_items_cluster_source_trace_unique" ON "gap_items" ("cluster_id","source","source_trace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gap_items_cluster_time_idx" ON "gap_items" ("cluster_id","trace_start_time" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gap_watermarks" (
	"worker_name" varchar(100) PRIMARY KEY NOT NULL,
	"last_ts" timestamp with time zone NOT NULL,
	"last_trace_id" varchar(32) DEFAULT '' NOT NULL,
	"lease_owner" varchar(200),
	"lease_until" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_cursor_move_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
