CREATE TABLE `calendar_event_overrides` (
	`id` varchar(191) NOT NULL,
	`event_id` varchar(191) NOT NULL,
	`occurrence_ms` bigint NOT NULL,
	`starts_at` bigint NOT NULL,
	`ends_at` bigint NOT NULL,
	`title` longtext,
	`description` longtext,
	`location` longtext,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `calendar_event_overrides_id` PRIMARY KEY(`id`),
	CONSTRAINT `calendar_event_overrides_event_occurrence_idx` UNIQUE(`event_id`,`occurrence_ms`)
);
--> statement-breakpoint
CREATE TABLE `calendar_invite_tombstones` (
	`id` varchar(191) NOT NULL,
	`user_id` varchar(191) NOT NULL,
	`invite_sequence` bigint NOT NULL DEFAULT 0,
	`invite_sender` longtext NOT NULL DEFAULT (''),
	`cancelled_at` bigint NOT NULL,
	CONSTRAINT `calendar_invite_tombstones_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `calendar_occurrence_responses` (
	`id` varchar(191) NOT NULL,
	`event_id` varchar(191) NOT NULL,
	`occurrence_ms` bigint NOT NULL,
	`guest` varchar(191) NOT NULL,
	`status` longtext NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `calendar_occurrence_responses_id` PRIMARY KEY(`id`),
	CONSTRAINT `calendar_occurrence_responses_event_occurrence_guest_idx` UNIQUE(`event_id`,`occurrence_ms`,`guest`)
);
--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `repeat_interval` bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `repeat_weekday` bigint;--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `repeat_week` bigint;--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `event_sequence` bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `calendar_event_overrides` ADD CONSTRAINT `calendar_event_overrides_event_id_calendar_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `calendar_events`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `calendar_invite_tombstones` ADD CONSTRAINT `calendar_invite_tombstones_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `calendar_occurrence_responses` ADD CONSTRAINT `calendar_occurrence_responses_event_id_calendar_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `calendar_events`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `calendar_event_overrides_event_idx` ON `calendar_event_overrides` (`event_id`);--> statement-breakpoint
CREATE INDEX `calendar_invite_tombstones_user_idx` ON `calendar_invite_tombstones` (`user_id`);--> statement-breakpoint
CREATE INDEX `calendar_occurrence_responses_event_idx` ON `calendar_occurrence_responses` (`event_id`);
