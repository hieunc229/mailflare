ALTER TABLE `calendar_resources` ADD `booking_token` longtext NOT NULL DEFAULT ('');
--> statement-breakpoint
ALTER TABLE `calendar_resource_bookings` ADD `conflict_at` bigint;
