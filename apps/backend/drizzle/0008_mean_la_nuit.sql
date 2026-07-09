CREATE TABLE "agent_config_version_kbs" (
	"version_id" uuid NOT NULL,
	"kb_id" uuid NOT NULL,
	CONSTRAINT "agent_config_version_kbs_version_id_kb_id_pk" PRIMARY KEY("version_id","kb_id")
);
--> statement-breakpoint
CREATE TABLE "agent_config_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"gen_model_id" uuid NOT NULL,
	"light_model_id" uuid,
	"rerank_model_id" uuid,
	"prompt_rewrite_ver_id" uuid NOT NULL,
	"prompt_intent_ver_id" uuid NOT NULL,
	"prompt_reply_ver_id" uuid NOT NULL,
	"prompt_fallback_ver_id" uuid NOT NULL,
	"node_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"top_k" integer NOT NULL,
	"top_n" integer NOT NULL,
	"threshold" real NOT NULL,
	"multi_recall" boolean DEFAULT true NOT NULL,
	"vec_weight" real,
	"fallback_human" boolean DEFAULT true NOT NULL,
	"eval_status" text DEFAULT 'not_run' NOT NULL,
	"eval_run_at" timestamp,
	"eval_pass_rate" real,
	"eval_summary" jsonb,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"published_by" text,
	"published_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"desc" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"current_version_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "agents_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "agent_config_version_kbs" ADD CONSTRAINT "agent_config_version_kbs_version_id_agent_config_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."agent_config_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config_version_kbs" ADD CONSTRAINT "agent_config_version_kbs_kb_id_knowledge_bases_id_fk" FOREIGN KEY ("kb_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config_versions" ADD CONSTRAINT "agent_config_versions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config_versions" ADD CONSTRAINT "agent_config_versions_gen_model_id_model_providers_id_fk" FOREIGN KEY ("gen_model_id") REFERENCES "public"."model_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config_versions" ADD CONSTRAINT "agent_config_versions_light_model_id_model_providers_id_fk" FOREIGN KEY ("light_model_id") REFERENCES "public"."model_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config_versions" ADD CONSTRAINT "agent_config_versions_rerank_model_id_model_providers_id_fk" FOREIGN KEY ("rerank_model_id") REFERENCES "public"."model_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config_versions" ADD CONSTRAINT "agent_config_versions_prompt_rewrite_ver_id_prompt_versions_id_fk" FOREIGN KEY ("prompt_rewrite_ver_id") REFERENCES "public"."prompt_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config_versions" ADD CONSTRAINT "agent_config_versions_prompt_intent_ver_id_prompt_versions_id_fk" FOREIGN KEY ("prompt_intent_ver_id") REFERENCES "public"."prompt_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config_versions" ADD CONSTRAINT "agent_config_versions_prompt_reply_ver_id_prompt_versions_id_fk" FOREIGN KEY ("prompt_reply_ver_id") REFERENCES "public"."prompt_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config_versions" ADD CONSTRAINT "agent_config_versions_prompt_fallback_ver_id_prompt_versions_id_fk" FOREIGN KEY ("prompt_fallback_ver_id") REFERENCES "public"."prompt_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_config_version_kbs_kb_id_idx" ON "agent_config_version_kbs" USING btree ("kb_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_config_versions_agent_id_version_idx" ON "agent_config_versions" USING btree ("agent_id","version");--> statement-breakpoint
CREATE INDEX "agent_config_versions_agent_id_status_idx" ON "agent_config_versions" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "agent_config_versions_agent_id_created_at_idx" ON "agent_config_versions" USING btree ("agent_id","created_at");