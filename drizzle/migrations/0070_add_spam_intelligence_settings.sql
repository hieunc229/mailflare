ALTER TABLE `app_settings` ADD `spamhaus_dqs_key` text;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `abusech_auth_key` text;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `spam_domain_age_check` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `spam_brands` text;
