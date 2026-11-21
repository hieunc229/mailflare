ALTER TABLE `app_settings` ADD `auto_update` boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE `app_settings` ADD `auto_update_dispatched_version` text;
--> statement-breakpoint
ALTER TABLE `app_settings` ADD `auto_update_channel` varchar(16) NOT NULL DEFAULT 'release';
