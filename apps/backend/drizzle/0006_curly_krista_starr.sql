CREATE TABLE "knowledge_bases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"desc" text DEFAULT '' NOT NULL,
	"chunk_template" text NOT NULL,
	"embedding_model_id" uuid NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"active_version" integer DEFAULT 1 NOT NULL,
	"building_version" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_bases_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kb_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"size" integer NOT NULL,
	"blob_key" text NOT NULL,
	"parsed_text" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"chunk_version" integer,
	"lifecycle" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"uploaded_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_id" uuid NOT NULL,
	"kb_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"seq" integer NOT NULL,
	"text" text NOT NULL,
	"token_count" integer NOT NULL,
	"section" text DEFAULT '' NOT NULL,
	"embedding" vector(1024) NOT NULL,
	CONSTRAINT "chunks_doc_version_seq_unique" UNIQUE("doc_id","version","seq")
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_kb_id_knowledge_bases_id_fk" FOREIGN KEY ("kb_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_doc_id_documents_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_kb_id_knowledge_bases_id_fk" FOREIGN KEY ("kb_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_kb_version_idx" ON "chunks" USING btree ("kb_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chunks_embedding_hnsw_idx" ON "chunks" USING hnsw ("embedding" vector_cosine_ops);