ALTER TABLE `app_settings` ADD `suppression_mode` text DEFAULT 'off' NOT NULL;
--> statement-breakpoint
ALTER TABLE `app_settings` ADD `resend_events_webhook_id` text;
--> statement-breakpoint
ALTER TABLE `app_settings` ADD `resend_events_webhook_secret` text;
--> statement-breakpoint
ALTER TABLE `app_settings` ADD `ses_feedback` text;
--> statement-breakpoint
CREATE TABLE `email_suppressions` (
	`id` text PRIMARY KEY NOT NULL,
	`domain_id` text NOT NULL,
	`email` text NOT NULL,
	`reason` text NOT NULL,
	`source` text NOT NULL,
	`detail` text,
	`confirmed` integer DEFAULT true NOT NULL,
	`evidence_ref` text,
	`event_count` integer DEFAULT 1 NOT NULL,
	`first_event_at` integer NOT NULL,
	`last_event_at` integer NOT NULL,
	`created_by_user_id` text,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_suppressions_domain_email_idx` ON `email_suppressions` (`domain_id`,`email`);
--> statement-breakpoint
CREATE INDEX `email_suppressions_created_by_idx` ON `email_suppressions` (`created_by_user_id`);
