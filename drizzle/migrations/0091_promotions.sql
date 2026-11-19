ALTER TABLE `messages` ADD `category` text;
--> statement-breakpoint
ALTER TABLE `messages` ADD `sender_address` text;
--> statement-breakpoint
CREATE INDEX `messages_category_page_idx` ON `messages` (`mailbox_id`,`category`,`status`,`folder_id`,`created_at` DESC,`id` DESC);
--> statement-breakpoint
CREATE INDEX `messages_category_count_idx` ON `messages` (`mailbox_id`,`category`,`folder_id`,`direction`,`status`,`read`,`snoozed_until`);
--> statement-breakpoint
CREATE TABLE `mailbox_promotion_settings` (
	`mailbox_id` text PRIMARY KEY NOT NULL,
	`mode` text DEFAULT 'off' NOT NULL,
	`backfill_status` text DEFAULT 'idle' NOT NULL,
	`backfill_cursor` text,
	`backfill_scanned` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mailbox_promotion_settings_backfill_idx` ON `mailbox_promotion_settings` (`backfill_status`);
--> statement-breakpoint
CREATE TABLE `mailbox_sender_preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`sender_address` text NOT NULL,
	`category_override` text,
	`unsubscribed_at` integer,
	`updated_by_user_id` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailbox_sender_preferences_mailbox_sender_idx` ON `mailbox_sender_preferences` (`mailbox_id`,`sender_address`);
--> statement-breakpoint
CREATE INDEX `mailbox_sender_preferences_updated_by_idx` ON `mailbox_sender_preferences` (`updated_by_user_id`);
