CREATE TABLE `mailbox_promotion_settings` (
	`mailbox_id` varchar(191) NOT NULL,
	`mode` varchar(64) NOT NULL DEFAULT 'off',
	`backfill_status` varchar(64) NOT NULL DEFAULT 'idle',
	`backfill_cursor` longtext,
	`backfill_scanned` int NOT NULL DEFAULT 0,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `mailbox_promotion_settings_mailbox_id` PRIMARY KEY(`mailbox_id`)
);
--> statement-breakpoint
CREATE TABLE `mailbox_sender_preferences` (
	`id` varchar(191) NOT NULL,
	`mailbox_id` varchar(191) NOT NULL,
	`sender_address` varchar(191) NOT NULL,
	`category_override` varchar(64),
	`unsubscribed_at` bigint,
	`updated_by_user_id` varchar(191),
	`updated_at` bigint NOT NULL,
	CONSTRAINT `mailbox_sender_preferences_id` PRIMARY KEY(`id`),
	CONSTRAINT `mailbox_sender_preferences_mailbox_sender_idx` UNIQUE(`mailbox_id`,`sender_address`)
);
--> statement-breakpoint
ALTER TABLE `messages` ADD `category` varchar(64);--> statement-breakpoint
ALTER TABLE `messages` ADD `sender_address` varchar(191);--> statement-breakpoint
ALTER TABLE `mailbox_promotion_settings` ADD CONSTRAINT `mailbox_promotion_settings_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mailbox_sender_preferences` ADD CONSTRAINT `mailbox_sender_preferences_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mailbox_sender_preferences` ADD CONSTRAINT `mailbox_sender_preferences_updated_by_user_id_users_id_fk` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `mailbox_promotion_settings_backfill_idx` ON `mailbox_promotion_settings` (`backfill_status`);--> statement-breakpoint
CREATE INDEX `mailbox_sender_preferences_updated_by_idx` ON `mailbox_sender_preferences` (`updated_by_user_id`);--> statement-breakpoint
CREATE INDEX `messages_category_page_idx` ON `messages` (`mailbox_id`,`category`,`status`,`folder_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `messages_category_count_idx` ON `messages` (`mailbox_id`,`category`,`folder_id`,`direction`,`status`,`read`,`snoozed_until`);
