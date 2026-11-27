ALTER TABLE `booking_events` ADD `resource_ids` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `calendar_resources` ADD `public_booking` integer DEFAULT false NOT NULL;
