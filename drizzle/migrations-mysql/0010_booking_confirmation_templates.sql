CREATE TABLE `booking_confirmation_templates` (
	`event_id` varchar(191) NOT NULL,
	`subject` longtext NOT NULL DEFAULT (''),
	`body` longtext NOT NULL DEFAULT (''),
	`updated_at` bigint NOT NULL,
	CONSTRAINT `booking_confirmation_templates_event_id` PRIMARY KEY(`event_id`)
);
--> statement-breakpoint
ALTER TABLE `booking_confirmation_templates` ADD CONSTRAINT `booking_confirmation_templates_event_id_booking_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `booking_events`(`id`) ON DELETE cascade ON UPDATE no action;
