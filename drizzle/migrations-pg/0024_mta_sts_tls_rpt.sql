ALTER TABLE "domain_deliverability" ADD COLUMN "tls_rpt_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "domain_deliverability" ADD COLUMN "mta_sts_mode" text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
ALTER TABLE "domain_deliverability" ADD COLUMN "mta_sts_policy_id" text;
--> statement-breakpoint
ALTER TABLE "domain_deliverability" ADD COLUMN "mta_sts_mx" text;
--> statement-breakpoint
ALTER TABLE "domain_deliverability" ADD COLUMN "mta_sts_max_age" bigint DEFAULT 604800 NOT NULL;
--> statement-breakpoint
ALTER TABLE "domain_deliverability" ADD COLUMN "mta_sts_served_max_age" bigint;
--> statement-breakpoint
ALTER TABLE "domain_deliverability" ADD COLUMN "mta_sts_verified_at" bigint;
--> statement-breakpoint
ALTER TABLE "domain_deliverability" ADD COLUMN "mta_sts_retire_after" bigint;
--> statement-breakpoint
ALTER TABLE "deliverability_reports" ADD COLUMN "kind" text DEFAULT 'dmarc' NOT NULL;
--> statement-breakpoint
CREATE TABLE "tls_daily_stats" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"day" text NOT NULL,
	"row_key" text NOT NULL,
	"reporter_org" text NOT NULL,
	"policy_type" text NOT NULL,
	"mx_host" text,
	"result_type" text NOT NULL,
	"success_count" bigint DEFAULT 0 NOT NULL,
	"failure_count" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tls_daily_stats" ADD CONSTRAINT "tls_daily_stats_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "tls_daily_stats_domain_day_key_idx" ON "tls_daily_stats" USING btree ("domain_id","day","row_key");
--> statement-breakpoint
CREATE INDEX "tls_daily_stats_day_idx" ON "tls_daily_stats" USING btree ("day");
