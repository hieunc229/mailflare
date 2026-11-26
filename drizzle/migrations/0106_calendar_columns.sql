ALTER TABLE `calendar_events` ADD `calendar_id` text;
--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `is_private` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `transparent` integer DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX `calendar_events_calendar_starts_idx` ON `calendar_events` (`calendar_id`,`starts_at`);
--> statement-breakpoint
CREATE TABLE `calendar_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`calendar_id` text NOT NULL,
	`grantee_user_id` text,
	`role` text NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`calendar_id`) REFERENCES `dav_collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`grantee_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_shares_calendar_grantee_idx` ON `calendar_shares` (`calendar_id`,`grantee_user_id`);
--> statement-breakpoint
CREATE INDEX `calendar_shares_grantee_idx` ON `calendar_shares` (`grantee_user_id`);
--> statement-breakpoint
CREATE TABLE `calendar_resources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'room' NOT NULL,
	`capacity` integer,
	`location` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_resources_name_idx` ON `calendar_resources` (`name`);
--> statement-breakpoint
CREATE TABLE `calendar_resource_bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`resource_id` text NOT NULL,
	`event_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`resource_id`) REFERENCES `calendar_resources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `calendar_events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_resource_bookings_resource_event_idx` ON `calendar_resource_bookings` (`resource_id`,`event_id`);
--> statement-breakpoint
CREATE INDEX `calendar_resource_bookings_resource_status_idx` ON `calendar_resource_bookings` (`resource_id`,`status`);
--> statement-breakpoint
CREATE INDEX `calendar_resource_bookings_event_idx` ON `calendar_resource_bookings` (`event_id`);
--> statement-breakpoint
-- The change-log triggers key a row by its calendar's collection: calendar_id, else the owner's default calendar `cal:<user_id>` (spec F9 8.2).
-- Existing rows have a null calendar_id, so every one still resolves to the collection it had; the migration writes no dav_changes rows.
-- A row that moves between collections is destroyed (under the name it was served by) in the old one and created in the new one.
-- Rows are never moved by a foreign-key cascade (MySQL fires no triggers for those): a calendar's events are deleted by statement first.
DROP TRIGGER IF EXISTS `dav_changes_calendar_events_ai`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `dav_changes_calendar_events_au`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `dav_changes_calendar_events_bd`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `dav_changes_calendar_events_ad`;
--> statement-breakpoint
CREATE TRIGGER `dav_changes_calendar_events_ai` AFTER INSERT ON `calendar_events` BEGIN
	INSERT INTO dav_changes (collection_id, object_key, change_type)
	VALUES (COALESCE(NEW.calendar_id, 'cal:' || NEW.user_id), coalesce(NEW.dav_object_id, NEW.id), CASE WHEN NEW.dav_object_id IS NULL OR NEW.dav_object_id = NEW.id THEN 'created' ELSE 'updated' END);
END;
--> statement-breakpoint
CREATE TRIGGER `dav_changes_calendar_events_au` AFTER UPDATE ON `calendar_events`
WHEN OLD.user_id <> NEW.user_id OR OLD.calendar_id IS NOT NEW.calendar_id OR OLD.is_private IS NOT NEW.is_private OR OLD.transparent IS NOT NEW.transparent OR OLD.mailbox_id IS NOT NEW.mailbox_id OR OLD.title IS NOT NEW.title OR OLD.description IS NOT NEW.description OR OLD.location IS NOT NEW.location OR OLD.attendees IS NOT NEW.attendees OR OLD.color IS NOT NEW.color OR OLD.repeat IS NOT NEW.repeat OR OLD.repeat_days IS NOT NEW.repeat_days OR OLD.excluded_occurrences IS NOT NEW.excluded_occurrences OR OLD.time_zone IS NOT NEW.time_zone OR OLD.response_status IS NOT NEW.response_status OR OLD.invite_message_id IS NOT NEW.invite_message_id OR OLD.invite_sender IS NOT NEW.invite_sender OR OLD.attendee_responses IS NOT NEW.attendee_responses OR OLD.repeat_anchor_day IS NOT NEW.repeat_anchor_day OR OLD.repeat_until IS NOT NEW.repeat_until OR OLD.starts_at IS NOT NEW.starts_at OR OLD.ends_at IS NOT NEW.ends_at OR OLD.reminder_minutes IS NOT NEW.reminder_minutes OR OLD.invite_sequence IS NOT NEW.invite_sequence OR OLD.event_sequence IS NOT NEW.event_sequence OR OLD.repeat_interval IS NOT NEW.repeat_interval OR OLD.repeat_weekday IS NOT NEW.repeat_weekday OR OLD.repeat_week IS NOT NEW.repeat_week OR OLD.updated_at IS NOT NEW.updated_at OR OLD.rrule IS NOT NEW.rrule OR OLD.recurrence_id IS NOT NEW.recurrence_id OR OLD.dav_object_id IS NOT NEW.dav_object_id OR OLD.all_day IS NOT NEW.all_day BEGIN
	INSERT INTO dav_changes (collection_id, object_key, change_type, resource_name)
	SELECT COALESCE(OLD.calendar_id, 'cal:' || OLD.user_id), OLD.id, 'destroyed', (SELECT name FROM dav_calendar_objects WHERE id = OLD.id)
	WHERE COALESCE(OLD.calendar_id, 'cal:' || OLD.user_id) <> COALESCE(NEW.calendar_id, 'cal:' || NEW.user_id) AND (OLD.dav_object_id IS NULL OR OLD.dav_object_id = OLD.id);
	INSERT INTO dav_changes (collection_id, object_key, change_type)
	VALUES (COALESCE(NEW.calendar_id, 'cal:' || NEW.user_id), coalesce(NEW.dav_object_id, NEW.id), CASE WHEN COALESCE(OLD.calendar_id, 'cal:' || OLD.user_id) <> COALESCE(NEW.calendar_id, 'cal:' || NEW.user_id) AND (NEW.dav_object_id IS NULL OR NEW.dav_object_id = NEW.id) THEN 'created' ELSE 'updated' END);
	INSERT INTO dav_changes (collection_id, object_key, change_type)
	SELECT COALESCE(OLD.calendar_id, 'cal:' || OLD.user_id), coalesce(OLD.dav_object_id, OLD.id), 'updated'
	WHERE (COALESCE(OLD.calendar_id, 'cal:' || OLD.user_id) = COALESCE(NEW.calendar_id, 'cal:' || NEW.user_id) AND coalesce(OLD.dav_object_id, OLD.id) <> coalesce(NEW.dav_object_id, NEW.id))
		OR (COALESCE(OLD.calendar_id, 'cal:' || OLD.user_id) <> COALESCE(NEW.calendar_id, 'cal:' || NEW.user_id) AND OLD.dav_object_id IS NOT NULL AND OLD.dav_object_id <> OLD.id);
END;
--> statement-breakpoint
CREATE TRIGGER `dav_changes_calendar_events_bd` BEFORE DELETE ON `calendar_events` BEGIN
	INSERT INTO dav_changes (collection_id, object_key, change_type, resource_name)
	SELECT COALESCE(OLD.calendar_id, 'cal:' || OLD.user_id), OLD.id, 'destroyed', (SELECT name FROM dav_calendar_objects WHERE id = OLD.id) WHERE OLD.dav_object_id IS NULL OR OLD.dav_object_id = OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER `dav_changes_calendar_events_ad` AFTER DELETE ON `calendar_events` BEGIN
	INSERT INTO dav_changes (collection_id, object_key, change_type)
	SELECT COALESCE(OLD.calendar_id, 'cal:' || OLD.user_id), OLD.dav_object_id, 'updated'
	WHERE OLD.dav_object_id <> OLD.id AND EXISTS (SELECT 1 FROM calendar_events WHERE id = OLD.dav_object_id);
END;
