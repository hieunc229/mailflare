CREATE TABLE `domain_deliverability` (
	`domain_id` varchar(191) NOT NULL,
	`reports_enabled` boolean NOT NULL DEFAULT false,
	`reports_enabled_at` bigint,
	`alert_email` boolean NOT NULL DEFAULT false,
	`last_report_at` bigint,
	`updated_at` bigint NOT NULL,
	`dmarc_created_record` longtext,
	CONSTRAINT `domain_deliverability_domain_id` PRIMARY KEY(`domain_id`)
);
--> statement-breakpoint
CREATE TABLE `deliverability_reports` (
	`id` varchar(191) NOT NULL,
	`domain_id` varchar(191) NOT NULL,
	`report_key` varchar(191) NOT NULL,
	`reporter_org` longtext,
	`reporter_email` longtext,
	`external_report_id` longtext,
	`date_begin` bigint,
	`date_end` bigint,
	`policy_p` longtext,
	`policy_pct` bigint,
	`record_count` bigint NOT NULL DEFAULT 0,
	`message_count` bigint NOT NULL DEFAULT 0,
	`authenticated` boolean NOT NULL DEFAULT false,
	`sender_domain` longtext,
	`verified_reporter` boolean NOT NULL DEFAULT false,
	`stats_rows` bigint NOT NULL DEFAULT 0,
	`status` varchar(64) NOT NULL DEFAULT 'processing',
	`error` longtext,
	`received_at` bigint NOT NULL,
	CONSTRAINT `deliverability_reports_id` PRIMARY KEY(`id`),
	CONSTRAINT `deliverability_reports_domain_key_idx` UNIQUE(`domain_id`,`report_key`)
);
--> statement-breakpoint
CREATE TABLE `dmarc_daily_stats` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`domain_id` varchar(191) NOT NULL,
	`day` varchar(191) NOT NULL,
	`row_key` varchar(191) NOT NULL,
	`source_ip` longtext NOT NULL,
	`source_host` longtext,
	`reporter_org` longtext NOT NULL,
	`header_from` longtext NOT NULL,
	`disposition` varchar(64) NOT NULL,
	`dkim_aligned` boolean NOT NULL,
	`spf_aligned` boolean NOT NULL,
	`message_count` bigint NOT NULL DEFAULT 0,
	CONSTRAINT `dmarc_daily_stats_id` PRIMARY KEY(`id`),
	CONSTRAINT `dmarc_daily_stats_domain_day_key_idx` UNIQUE(`domain_id`,`day`,`row_key`)
);
--> statement-breakpoint
CREATE TABLE `deliverability_alerts` (
	`id` varchar(191) NOT NULL,
	`domain_id` varchar(191) NOT NULL,
	`kind` varchar(64) NOT NULL,
	`day` varchar(191) NOT NULL,
	`detail` longtext NOT NULL,
	`created_at` bigint NOT NULL,
	`acknowledged_at` bigint,
	`acknowledged_by_user_id` varchar(191),
	CONSTRAINT `deliverability_alerts_id` PRIMARY KEY(`id`),
	CONSTRAINT `deliverability_alerts_domain_kind_day_idx` UNIQUE(`domain_id`,`kind`,`day`)
);
--> statement-breakpoint
ALTER TABLE `domain_deliverability` ADD CONSTRAINT `domain_deliverability_domain_id_domains_id_fk` FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `deliverability_reports` ADD CONSTRAINT `deliverability_reports_domain_id_domains_id_fk` FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `dmarc_daily_stats` ADD CONSTRAINT `dmarc_daily_stats_domain_id_domains_id_fk` FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `deliverability_alerts` ADD CONSTRAINT `deliverability_alerts_domain_id_domains_id_fk` FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `deliverability_alerts` ADD CONSTRAINT `deliverability_alerts_acknowledged_by_user_id_users_id_fk` FOREIGN KEY (`acknowledged_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `deliverability_reports_domain_received_idx` ON `deliverability_reports` (`domain_id`,`received_at`);
--> statement-breakpoint
CREATE INDEX `deliverability_reports_received_idx` ON `deliverability_reports` (`received_at`);
--> statement-breakpoint
CREATE INDEX `dmarc_daily_stats_day_idx` ON `dmarc_daily_stats` (`day`);
--> statement-breakpoint
CREATE INDEX `deliverability_alerts_ack_user_idx` ON `deliverability_alerts` (`acknowledged_by_user_id`);
