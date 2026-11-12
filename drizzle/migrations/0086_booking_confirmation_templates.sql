CREATE TABLE `booking_confirmation_templates` (
	`event_id` text PRIMARY KEY NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `booking_events`(`id`) ON UPDATE no action ON DELETE cascade
);
