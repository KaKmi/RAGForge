CREATE TABLE "document_processing_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"kb_id" uuid NOT NULL,
	"target_version" integer NOT NULL,
	"profile_id" text NOT NULL,
	"profile_version" integer NOT NULL,
	"profile_snapshot" jsonb NOT NULL,
	"parser_engine" text,
	"parser_version" text,
	"canonical_blob_key" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp,
	"ended_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD COLUMN "default_profile_id" text;--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD COLUMN "default_profile_version" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "profile_override_id" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "profile_override_version" integer;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "processing_run_id" uuid;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "content_type" text;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "page_start" integer;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "page_end" integer;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "asset_key" text;--> statement-breakpoint
ALTER TABLE "document_processing_runs" ADD CONSTRAINT "document_processing_runs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_processing_runs" ADD CONSTRAINT "document_processing_runs_kb_id_knowledge_bases_id_fk" FOREIGN KEY ("kb_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dpr_active_doc_unique" ON "document_processing_runs" USING btree ("document_id") WHERE status in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "dpr_doc_created_idx" ON "document_processing_runs" USING btree ("document_id","created_at");--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_processing_run_id_document_processing_runs_id_fk" FOREIGN KEY ("processing_run_id") REFERENCES "public"."document_processing_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "knowledge_bases" SET
	"default_profile_id" = CASE "chunk_template" WHEN 'qa' THEN 'faq-v1' WHEN 'custom' THEN 'course-wechat-v1' ELSE 'general-v1' END,
	"default_profile_version" = 1
WHERE "default_profile_id" IS NULL;
