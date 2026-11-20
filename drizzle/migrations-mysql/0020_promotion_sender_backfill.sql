ALTER TABLE `mailbox_promotion_settings` ADD `backfill_stalls` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `mailbox_promotion_settings` ADD `backfill_error` longtext;--> statement-breakpoint
ALTER TABLE `mailbox_promotion_settings` ADD `backfill_day` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `mailbox_promotion_settings` ADD `backfill_day_rows` int DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `messages_sender_idx` ON `messages` (`mailbox_id`,`sender_address`,`created_at`);
