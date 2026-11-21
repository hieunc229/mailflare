ALTER TABLE `app_settings` ADD `auto_update` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `app_settings` ADD `auto_update_dispatched_version` text;
--> statement-breakpoint
ALTER TABLE `app_settings` ADD `auto_update_channel` text NOT NULL DEFAULT 'release';
