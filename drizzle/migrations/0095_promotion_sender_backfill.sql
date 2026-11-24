CREATE INDEX `messages_sender_idx` ON `messages` (`mailbox_id`,`sender_address`,`created_at`);
--> statement-breakpoint
ALTER TABLE `mailbox_promotion_settings` ADD `backfill_stalls` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `mailbox_promotion_settings` ADD `backfill_error` text;
--> statement-breakpoint
ALTER TABLE `mailbox_promotion_settings` ADD `backfill_day` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `mailbox_promotion_settings` ADD `backfill_day_rows` integer DEFAULT 0 NOT NULL;
