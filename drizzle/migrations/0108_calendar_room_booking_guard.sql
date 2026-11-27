ALTER TABLE `calendar_resources` ADD `booking_token` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `calendar_resource_bookings` ADD `conflict_at` integer;
