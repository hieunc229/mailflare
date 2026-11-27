ALTER TABLE `booking_events` ADD `resource_ids` longtext NOT NULL DEFAULT ('[]');
--> statement-breakpoint
ALTER TABLE `calendar_resources` ADD `public_booking` boolean NOT NULL DEFAULT false;
