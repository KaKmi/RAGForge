CREATE TABLE "application_config_version_kbs" (
	"config_version_id" uuid NOT NULL,
	"kb_id" uuid NOT NULL,
	CONSTRAINT "application_config_version_kbs_config_version_id_kb_id_pk" PRIMARY KEY("config_version_id","kb_id")
);
--> statement-breakpoint
CREATE TABLE "application_config_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"config_schema_version" integer DEFAULT 1 NOT NULL,
	"prompt_rewrite_version_id" uuid NOT NULL,
	"prompt_intent_version_id" uuid NOT NULL,
	"prompt_reply_version_id" uuid NOT NULL,
	"prompt_fallback_version_id" uuid NOT NULL,
	"rewrite_model_id" uuid NOT NULL,
	"intent_model_id" uuid NOT NULL,
	"reply_model_id" uuid NOT NULL,
	"fallback_model_id" uuid NOT NULL,
	"rerank_model_id" uuid,
	"node_params" jsonb NOT NULL,
	"retrieval_params" jsonb NOT NULL,
	"fallback_params" jsonb NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"production_config_version_id" uuid,
	"deleted_at" timestamp,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "applications_slug_unique" UNIQUE("slug"),
	CONSTRAINT "applications_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "application_config_version_kbs" ADD CONSTRAINT "application_config_version_kbs_config_version_id_application_config_versions_id_fk" FOREIGN KEY ("config_version_id") REFERENCES "public"."application_config_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_config_version_kbs" ADD CONSTRAINT "application_config_version_kbs_kb_id_knowledge_bases_id_fk" FOREIGN KEY ("kb_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_config_versions" ADD CONSTRAINT "application_config_versions_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_config_versions" ADD CONSTRAINT "application_config_versions_prompt_rewrite_version_id_prompt_versions_id_fk" FOREIGN KEY ("prompt_rewrite_version_id") REFERENCES "public"."prompt_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_config_versions" ADD CONSTRAINT "application_config_versions_prompt_intent_version_id_prompt_versions_id_fk" FOREIGN KEY ("prompt_intent_version_id") REFERENCES "public"."prompt_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_config_versions" ADD CONSTRAINT "application_config_versions_prompt_reply_version_id_prompt_versions_id_fk" FOREIGN KEY ("prompt_reply_version_id") REFERENCES "public"."prompt_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_config_versions" ADD CONSTRAINT "application_config_versions_prompt_fallback_version_id_prompt_versions_id_fk" FOREIGN KEY ("prompt_fallback_version_id") REFERENCES "public"."prompt_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_config_versions" ADD CONSTRAINT "application_config_versions_rewrite_model_id_model_providers_id_fk" FOREIGN KEY ("rewrite_model_id") REFERENCES "public"."model_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_config_versions" ADD CONSTRAINT "application_config_versions_intent_model_id_model_providers_id_fk" FOREIGN KEY ("intent_model_id") REFERENCES "public"."model_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_config_versions" ADD CONSTRAINT "application_config_versions_reply_model_id_model_providers_id_fk" FOREIGN KEY ("reply_model_id") REFERENCES "public"."model_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_config_versions" ADD CONSTRAINT "application_config_versions_fallback_model_id_model_providers_id_fk" FOREIGN KEY ("fallback_model_id") REFERENCES "public"."model_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_config_versions" ADD CONSTRAINT "application_config_versions_rerank_model_id_model_providers_id_fk" FOREIGN KEY ("rerank_model_id") REFERENCES "public"."model_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_config_version_kbs_kb_id_idx" ON "application_config_version_kbs" USING btree ("kb_id");--> statement-breakpoint
CREATE UNIQUE INDEX "application_config_versions_application_id_version_idx" ON "application_config_versions" USING btree ("application_id","version");--> statement-breakpoint
CREATE INDEX "application_config_versions_application_id_created_at_idx" ON "application_config_versions" USING btree ("application_id","created_at" DESC NULLS LAST);
