ALTER TABLE `app_settings` ADD `suppression_mode` varchar(64) NOT NULL DEFAULT 'off';
--> statement-breakpoint
ALTER TABLE `app_settings` ADD `resend_events_webhook_id` longtext;
--> statement-breakpoint
ALTER TABLE `app_settings` ADD `resend_events_webhook_secret` longtext;
--> statement-breakpoint
ALTER TABLE `app_settings` ADD `ses_feedback` longtext;
--> statement-breakpoint
CREATE TABLE `email_suppressions` (
	`id` varchar(191) NOT NULL,
	`domain_id` varchar(191) NOT NULL,
	`email` varchar(320) NOT NULL,
	`reason` varchar(64) NOT NULL,
	`source` varchar(64) NOT NULL,
	`detail` longtext,
	`confirmed` boolean NOT NULL DEFAULT true,
	`evidence_ref` longtext,
	`event_count` bigint NOT NULL DEFAULT 1,
	`first_event_at` bigint NOT NULL,
	`last_event_at` bigint NOT NULL,
	`created_by_user_id` varchar(191),
	CONSTRAINT `email_suppressions_id` PRIMARY KEY(`id`),
	CONSTRAINT `email_suppressions_domain_email_idx` UNIQUE(`domain_id`,`email`)
);
--> statement-breakpoint
ALTER TABLE `email_suppressions` ADD CONSTRAINT `email_suppressions_domain_id_domains_id_fk` FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `email_suppressions` ADD CONSTRAINT `email_suppressions_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `email_suppressions_created_by_idx` ON `email_suppressions` (`created_by_user_id`);
