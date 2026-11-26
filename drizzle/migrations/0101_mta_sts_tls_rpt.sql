ALTER TABLE `domain_deliverability` ADD `tls_rpt_enabled` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `domain_deliverability` ADD `mta_sts_mode` text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
ALTER TABLE `domain_deliverability` ADD `mta_sts_policy_id` text;
--> statement-breakpoint
ALTER TABLE `domain_deliverability` ADD `mta_sts_mx` text;
--> statement-breakpoint
ALTER TABLE `domain_deliverability` ADD `mta_sts_max_age` integer DEFAULT 604800 NOT NULL;
--> statement-breakpoint
ALTER TABLE `domain_deliverability` ADD `mta_sts_served_max_age` integer;
--> statement-breakpoint
ALTER TABLE `domain_deliverability` ADD `mta_sts_verified_at` integer;
--> statement-breakpoint
ALTER TABLE `domain_deliverability` ADD `mta_sts_retire_after` integer;
--> statement-breakpoint
ALTER TABLE `deliverability_reports` ADD `kind` text DEFAULT 'dmarc' NOT NULL;
--> statement-breakpoint
CREATE TABLE `tls_daily_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain_id` text NOT NULL,
	`day` text NOT NULL,
	`row_key` text NOT NULL,
	`reporter_org` text NOT NULL,
	`policy_type` text NOT NULL,
	`mx_host` text,
	`result_type` text NOT NULL,
	`success_count` integer DEFAULT 0 NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tls_daily_stats_domain_day_key_idx` ON `tls_daily_stats` (`domain_id`,`day`,`row_key`);
--> statement-breakpoint
CREATE INDEX `tls_daily_stats_day_idx` ON `tls_daily_stats` (`day`);
