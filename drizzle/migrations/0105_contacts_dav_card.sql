ALTER TABLE `contacts` ADD `dav_card_id` text;
--> statement-breakpoint
CREATE INDEX `contacts_dav_card_idx` ON `contacts` (`dav_card_id`);
--> statement-breakpoint
ALTER TABLE `dav_collections` ADD `seed_started_at` integer;
--> statement-breakpoint
ALTER TABLE `dav_collections` ADD `seed_cursor` text;
