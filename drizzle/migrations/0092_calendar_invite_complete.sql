ALTER TABLE `calendar_events` ADD `repeat_interval` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `repeat_weekday` integer;
--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `repeat_week` integer;
--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `event_sequence` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE `calendar_event_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`occurrence_ms` integer NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`title` text,
	`description` text,
	`location` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `calendar_events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `calendar_invite_tombstones` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`invite_sequence` integer NOT NULL DEFAULT 0,
	`invite_sender` text NOT NULL DEFAULT '',
	`cancelled_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `calendar_occurrence_responses` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`occurrence_ms` integer NOT NULL,
	`guest` text NOT NULL,
	`status` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `calendar_events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_event_overrides_event_occurrence_idx` ON `calendar_event_overrides` (`event_id`,`occurrence_ms`);
--> statement-breakpoint
CREATE INDEX `calendar_event_overrides_event_idx` ON `calendar_event_overrides` (`event_id`);
--> statement-breakpoint
CREATE INDEX `calendar_invite_tombstones_user_idx` ON `calendar_invite_tombstones` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_occurrence_responses_event_occurrence_guest_idx` ON `calendar_occurrence_responses` (`event_id`,`occurrence_ms`,`guest`);
--> statement-breakpoint
CREATE INDEX `calendar_occurrence_responses_event_idx` ON `calendar_occurrence_responses` (`event_id`);
