ALTER TABLE `domain_deliverability` ADD `tls_rpt_enabled` boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE `domain_deliverability` ADD `mta_sts_mode` varchar(64) NOT NULL DEFAULT 'none';
--> statement-breakpoint
ALTER TABLE `domain_deliverability` ADD `mta_sts_policy_id` longtext;
--> statement-breakpoint
ALTER TABLE `domain_deliverability` ADD `mta_sts_mx` longtext;
--> statement-breakpoint
ALTER TABLE `domain_deliverability` ADD `mta_sts_max_age` bigint NOT NULL DEFAULT 604800;
--> statement-breakpoint
ALTER TABLE `domain_deliverability` ADD `mta_sts_served_max_age` bigint;
--> statement-breakpoint
ALTER TABLE `domain_deliverability` ADD `mta_sts_verified_at` bigint;
--> statement-breakpoint
ALTER TABLE `domain_deliverability` ADD `mta_sts_retire_after` bigint;
--> statement-breakpoint
ALTER TABLE `deliverability_reports` ADD `kind` varchar(64) NOT NULL DEFAULT 'dmarc';
--> statement-breakpoint
CREATE TABLE `tls_daily_stats` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`domain_id` varchar(191) NOT NULL,
	`day` varchar(191) NOT NULL,
	`row_key` varchar(191) NOT NULL,
	`reporter_org` longtext NOT NULL,
	`policy_type` longtext NOT NULL,
	`mx_host` longtext,
	`result_type` longtext NOT NULL,
	`success_count` bigint NOT NULL DEFAULT 0,
	`failure_count` bigint NOT NULL DEFAULT 0,
	CONSTRAINT `tls_daily_stats_id` PRIMARY KEY(`id`),
	CONSTRAINT `tls_daily_stats_domain_day_key_idx` UNIQUE(`domain_id`,`day`,`row_key`)
);
--> statement-breakpoint
ALTER TABLE `tls_daily_stats` ADD CONSTRAINT `tls_daily_stats_domain_id_domains_id_fk` FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `tls_daily_stats_day_idx` ON `tls_daily_stats` (`day`);
