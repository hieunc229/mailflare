CREATE TABLE "domain_deliverability" (
	"domain_id" text PRIMARY KEY NOT NULL,
	"reports_enabled" boolean DEFAULT false NOT NULL,
	"reports_enabled_at" bigint,
	"alert_email" boolean DEFAULT false NOT NULL,
	"last_report_at" bigint,
	"updated_at" bigint NOT NULL,
	"dmarc_created_record" text
);
--> statement-breakpoint
CREATE TABLE "deliverability_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"report_key" text NOT NULL,
	"reporter_org" text,
	"reporter_email" text,
	"external_report_id" text,
	"date_begin" bigint,
	"date_end" bigint,
	"policy_p" text,
	"policy_pct" bigint,
	"record_count" bigint DEFAULT 0 NOT NULL,
	"message_count" bigint DEFAULT 0 NOT NULL,
	"authenticated" boolean DEFAULT false NOT NULL,
	"sender_domain" text,
	"verified_reporter" boolean DEFAULT false NOT NULL,
	"stats_rows" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"error" text,
	"received_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dmarc_daily_stats" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"day" text NOT NULL,
	"row_key" text NOT NULL,
	"source_ip" text NOT NULL,
	"source_host" text,
	"reporter_org" text NOT NULL,
	"header_from" text NOT NULL,
	"disposition" text NOT NULL,
	"dkim_aligned" boolean NOT NULL,
	"spf_aligned" boolean NOT NULL,
	"message_count" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliverability_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"kind" text NOT NULL,
	"day" text NOT NULL,
	"detail" text NOT NULL,
	"created_at" bigint NOT NULL,
	"acknowledged_at" bigint,
	"acknowledged_by_user_id" text
);
--> statement-breakpoint
ALTER TABLE "domain_deliverability" ADD CONSTRAINT "domain_deliverability_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "deliverability_reports" ADD CONSTRAINT "deliverability_reports_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "dmarc_daily_stats" ADD CONSTRAINT "dmarc_daily_stats_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "deliverability_alerts" ADD CONSTRAINT "deliverability_alerts_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "deliverability_alerts" ADD CONSTRAINT "deliverability_alerts_acknowledged_by_user_id_users_id_fk" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "deliverability_reports_domain_key_idx" ON "deliverability_reports" USING btree ("domain_id","report_key");
--> statement-breakpoint
CREATE INDEX "deliverability_reports_domain_received_idx" ON "deliverability_reports" USING btree ("domain_id","received_at");
--> statement-breakpoint
CREATE INDEX "deliverability_reports_received_idx" ON "deliverability_reports" USING btree ("received_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "dmarc_daily_stats_domain_day_key_idx" ON "dmarc_daily_stats" USING btree ("domain_id","day","row_key");
--> statement-breakpoint
CREATE INDEX "dmarc_daily_stats_day_idx" ON "dmarc_daily_stats" USING btree ("day");
--> statement-breakpoint
CREATE UNIQUE INDEX "deliverability_alerts_domain_kind_day_idx" ON "deliverability_alerts" USING btree ("domain_id","kind","day");
--> statement-breakpoint
CREATE INDEX "deliverability_alerts_ack_user_idx" ON "deliverability_alerts" USING btree ("acknowledged_by_user_id");
