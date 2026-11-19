ALTER TABLE "app_settings" ADD COLUMN "suppression_mode" text DEFAULT 'off' NOT NULL;
--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "resend_events_webhook_id" text;
--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "resend_events_webhook_secret" text;
--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "ses_feedback" text;
--> statement-breakpoint
CREATE TABLE "email_suppressions" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"email" text NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"detail" text,
	"confirmed" boolean DEFAULT true NOT NULL,
	"evidence_ref" text,
	"event_count" bigint DEFAULT 1 NOT NULL,
	"first_event_at" bigint NOT NULL,
	"last_event_at" bigint NOT NULL,
	"created_by_user_id" text
);
--> statement-breakpoint
ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "email_suppressions_domain_email_idx" ON "email_suppressions" USING btree ("domain_id","email");
--> statement-breakpoint
CREATE INDEX "email_suppressions_created_by_idx" ON "email_suppressions" USING btree ("created_by_user_id");
