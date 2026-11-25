CREATE TABLE `domain_deliverability` (
	`domain_id` text PRIMARY KEY NOT NULL,
	`reports_enabled` integer DEFAULT false NOT NULL,
	`reports_enabled_at` integer,
	`alert_email` integer DEFAULT false NOT NULL,
	`last_report_at` integer,
	`updated_at` integer NOT NULL,
	`dmarc_created_record` text,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `deliverability_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`domain_id` text NOT NULL,
	`report_key` text NOT NULL,
	`reporter_org` text,
	`reporter_email` text,
	`external_report_id` text,
	`date_begin` integer,
	`date_end` integer,
	`policy_p` text,
	`policy_pct` integer,
	`record_count` integer DEFAULT 0 NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	`authenticated` integer DEFAULT false NOT NULL,
	`sender_domain` text,
	`verified_reporter` integer DEFAULT false NOT NULL,
	`stats_rows` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`error` text,
	`received_at` integer NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deliverability_reports_domain_key_idx` ON `deliverability_reports` (`domain_id`,`report_key`);
--> statement-breakpoint
CREATE INDEX `deliverability_reports_domain_received_idx` ON `deliverability_reports` (`domain_id`,`received_at`);
--> statement-breakpoint
CREATE INDEX `deliverability_reports_received_idx` ON `deliverability_reports` (`received_at`);
--> statement-breakpoint
CREATE TABLE `dmarc_daily_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain_id` text NOT NULL,
	`day` text NOT NULL,
	`row_key` text NOT NULL,
	`source_ip` text NOT NULL,
	`source_host` text,
	`reporter_org` text NOT NULL,
	`header_from` text NOT NULL,
	`disposition` text NOT NULL,
	`dkim_aligned` integer NOT NULL,
	`spf_aligned` integer NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dmarc_daily_stats_domain_day_key_idx` ON `dmarc_daily_stats` (`domain_id`,`day`,`row_key`);
--> statement-breakpoint
CREATE INDEX `dmarc_daily_stats_day_idx` ON `dmarc_daily_stats` (`day`);
--> statement-breakpoint
CREATE TABLE `deliverability_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`domain_id` text NOT NULL,
	`kind` text NOT NULL,
	`day` text NOT NULL,
	`detail` text NOT NULL,
	`created_at` integer NOT NULL,
	`acknowledged_at` integer,
	`acknowledged_by_user_id` text,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`acknowledged_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deliverability_alerts_domain_kind_day_idx` ON `deliverability_alerts` (`domain_id`,`kind`,`day`);
--> statement-breakpoint
CREATE INDEX `deliverability_alerts_ack_user_idx` ON `deliverability_alerts` (`acknowledged_by_user_id`);
