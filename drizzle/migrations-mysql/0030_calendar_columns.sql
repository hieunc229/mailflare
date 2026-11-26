ALTER TABLE `calendar_events` ADD `calendar_id` varchar(191);
--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `is_private` boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `transparent` boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX `calendar_events_calendar_starts_idx` ON `calendar_events` (`calendar_id`,`starts_at`);
--> statement-breakpoint
CREATE TABLE `calendar_shares` (
	`id` varchar(191) NOT NULL,
	`calendar_id` varchar(191) NOT NULL,
	`grantee_user_id` varchar(191),
	`role` varchar(64) NOT NULL,
	`created_by_user_id` varchar(191),
	`created_at` bigint NOT NULL,
	CONSTRAINT `calendar_shares_id` PRIMARY KEY(`id`),
	CONSTRAINT `calendar_shares_calendar_grantee_idx` UNIQUE(`calendar_id`,`grantee_user_id`)
);
--> statement-breakpoint
CREATE TABLE `calendar_resources` (
	`id` varchar(191) NOT NULL,
	`name` varchar(255) NOT NULL,
	`kind` varchar(64) NOT NULL DEFAULT 'room',
	`capacity` bigint,
	`location` longtext NOT NULL DEFAULT (''),
	`description` longtext NOT NULL DEFAULT (''),
	`disabled` boolean NOT NULL DEFAULT false,
	`created_by_user_id` varchar(191),
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `calendar_resources_id` PRIMARY KEY(`id`),
	CONSTRAINT `calendar_resources_name_idx` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `calendar_resource_bookings` (
	`id` varchar(191) NOT NULL,
	`resource_id` varchar(191) NOT NULL,
	`event_id` varchar(191) NOT NULL,
	`status` varchar(64) NOT NULL,
	`created_at` bigint NOT NULL,
	CONSTRAINT `calendar_resource_bookings_id` PRIMARY KEY(`id`),
	CONSTRAINT `calendar_resource_bookings_resource_event_idx` UNIQUE(`resource_id`,`event_id`)
);
--> statement-breakpoint
ALTER TABLE `calendar_shares` ADD CONSTRAINT `calendar_shares_calendar_id_dav_collections_id_fk` FOREIGN KEY (`calendar_id`) REFERENCES `dav_collections`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `calendar_shares` ADD CONSTRAINT `calendar_shares_grantee_user_id_users_id_fk` FOREIGN KEY (`grantee_user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `calendar_shares` ADD CONSTRAINT `calendar_shares_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `calendar_resources` ADD CONSTRAINT `calendar_resources_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `calendar_resource_bookings` ADD CONSTRAINT `calendar_resource_bookings_resource_id_calendar_resources_id_fk` FOREIGN KEY (`resource_id`) REFERENCES `calendar_resources`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `calendar_resource_bookings` ADD CONSTRAINT `calendar_resource_bookings_event_id_calendar_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `calendar_events`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `calendar_shares_grantee_idx` ON `calendar_shares` (`grantee_user_id`);
--> statement-breakpoint
CREATE INDEX `calendar_resource_bookings_resource_status_idx` ON `calendar_resource_bookings` (`resource_id`,`status`);
--> statement-breakpoint
CREATE INDEX `calendar_resource_bookings_event_idx` ON `calendar_resource_bookings` (`event_id`);
--> statement-breakpoint
-- The change-log triggers key a row by its calendar's collection: calendar_id, else the owner's default calendar `cal:<user_id>` (spec F9 8.2).
-- Existing rows have a null calendar_id, so every one still resolves to the collection it had; the migration writes no dav_changes rows.
-- A row that moves between collections is destroyed (under the name it was served by) in the old one and created in the new one.
-- MySQL fires no trigger for rows removed by a foreign-key cascade, so a calendar's events are deleted by statement before the calendar.
DROP TRIGGER IF EXISTS dav_changes_calendar_events_ai;
--> statement-breakpoint
DROP TRIGGER IF EXISTS dav_changes_calendar_events_au;
--> statement-breakpoint
DROP TRIGGER IF EXISTS dav_changes_calendar_events_bd;
--> statement-breakpoint
DROP TRIGGER IF EXISTS dav_changes_calendar_events_ad;
--> statement-breakpoint
CREATE TRIGGER dav_changes_calendar_events_ai AFTER INSERT ON calendar_events FOR EACH ROW
BEGIN
	INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES (COALESCE(NEW.calendar_id, CONCAT('cal:', NEW.user_id)), COALESCE(NEW.dav_object_id, NEW.id), CASE WHEN NEW.dav_object_id IS NULL OR CAST(NEW.dav_object_id AS BINARY) = CAST(NEW.id AS BINARY) THEN 'created' ELSE 'updated' END);
END;
--> statement-breakpoint
CREATE TRIGGER dav_changes_calendar_events_au AFTER UPDATE ON calendar_events FOR EACH ROW
BEGIN
	IF NOT (CAST(OLD.user_id AS BINARY) <=> CAST(NEW.user_id AS BINARY)) OR NOT (CAST(OLD.calendar_id AS BINARY) <=> CAST(NEW.calendar_id AS BINARY) AND OLD.is_private <=> NEW.is_private AND OLD.transparent <=> NEW.transparent AND CAST(OLD.mailbox_id AS BINARY) <=> CAST(NEW.mailbox_id AS BINARY) AND CAST(OLD.title AS BINARY) <=> CAST(NEW.title AS BINARY) AND CAST(OLD.description AS BINARY) <=> CAST(NEW.description AS BINARY) AND CAST(OLD.location AS BINARY) <=> CAST(NEW.location AS BINARY) AND CAST(OLD.attendees AS BINARY) <=> CAST(NEW.attendees AS BINARY) AND CAST(OLD.color AS BINARY) <=> CAST(NEW.color AS BINARY) AND CAST(OLD.`repeat` AS BINARY) <=> CAST(NEW.`repeat` AS BINARY) AND CAST(OLD.repeat_days AS BINARY) <=> CAST(NEW.repeat_days AS BINARY) AND CAST(OLD.excluded_occurrences AS BINARY) <=> CAST(NEW.excluded_occurrences AS BINARY) AND CAST(OLD.time_zone AS BINARY) <=> CAST(NEW.time_zone AS BINARY) AND CAST(OLD.response_status AS BINARY) <=> CAST(NEW.response_status AS BINARY) AND CAST(OLD.invite_message_id AS BINARY) <=> CAST(NEW.invite_message_id AS BINARY) AND CAST(OLD.invite_sender AS BINARY) <=> CAST(NEW.invite_sender AS BINARY) AND CAST(OLD.attendee_responses AS BINARY) <=> CAST(NEW.attendee_responses AS BINARY) AND OLD.repeat_anchor_day <=> NEW.repeat_anchor_day AND OLD.repeat_until <=> NEW.repeat_until AND OLD.starts_at <=> NEW.starts_at AND OLD.ends_at <=> NEW.ends_at AND OLD.reminder_minutes <=> NEW.reminder_minutes AND OLD.invite_sequence <=> NEW.invite_sequence AND OLD.event_sequence <=> NEW.event_sequence AND OLD.repeat_interval <=> NEW.repeat_interval AND OLD.repeat_weekday <=> NEW.repeat_weekday AND OLD.repeat_week <=> NEW.repeat_week AND OLD.updated_at <=> NEW.updated_at AND CAST(OLD.rrule AS BINARY) <=> CAST(NEW.rrule AS BINARY) AND OLD.recurrence_id <=> NEW.recurrence_id AND CAST(OLD.dav_object_id AS BINARY) <=> CAST(NEW.dav_object_id AS BINARY) AND OLD.all_day <=> NEW.all_day) THEN
		IF NOT (CAST(COALESCE(OLD.calendar_id, CONCAT('cal:', OLD.user_id)) AS BINARY) <=> CAST(COALESCE(NEW.calendar_id, CONCAT('cal:', NEW.user_id)) AS BINARY)) AND (OLD.dav_object_id IS NULL OR CAST(OLD.dav_object_id AS BINARY) = CAST(OLD.id AS BINARY)) THEN
			INSERT INTO dav_changes (collection_id, object_key, change_type, resource_name) VALUES (COALESCE(OLD.calendar_id, CONCAT('cal:', OLD.user_id)), OLD.id, 'destroyed', (SELECT name FROM dav_calendar_objects WHERE id = OLD.id));
		END IF;
		INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES (COALESCE(NEW.calendar_id, CONCAT('cal:', NEW.user_id)), COALESCE(NEW.dav_object_id, NEW.id), CASE WHEN NOT (CAST(COALESCE(OLD.calendar_id, CONCAT('cal:', OLD.user_id)) AS BINARY) <=> CAST(COALESCE(NEW.calendar_id, CONCAT('cal:', NEW.user_id)) AS BINARY)) AND (NEW.dav_object_id IS NULL OR CAST(NEW.dav_object_id AS BINARY) = CAST(NEW.id AS BINARY)) THEN 'created' ELSE 'updated' END);
		IF (CAST(COALESCE(OLD.calendar_id, CONCAT('cal:', OLD.user_id)) AS BINARY) <=> CAST(COALESCE(NEW.calendar_id, CONCAT('cal:', NEW.user_id)) AS BINARY) AND NOT (CAST(COALESCE(OLD.dav_object_id, OLD.id) AS BINARY) <=> CAST(COALESCE(NEW.dav_object_id, NEW.id) AS BINARY))) OR (NOT (CAST(COALESCE(OLD.calendar_id, CONCAT('cal:', OLD.user_id)) AS BINARY) <=> CAST(COALESCE(NEW.calendar_id, CONCAT('cal:', NEW.user_id)) AS BINARY)) AND OLD.dav_object_id IS NOT NULL AND CAST(OLD.dav_object_id AS BINARY) <> CAST(OLD.id AS BINARY)) THEN
			INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES (COALESCE(OLD.calendar_id, CONCAT('cal:', OLD.user_id)), COALESCE(OLD.dav_object_id, OLD.id), 'updated');
		END IF;
	END IF;
END;
--> statement-breakpoint
CREATE TRIGGER dav_changes_calendar_events_bd BEFORE DELETE ON calendar_events FOR EACH ROW
BEGIN
	IF OLD.dav_object_id IS NULL OR CAST(OLD.dav_object_id AS BINARY) = CAST(OLD.id AS BINARY) THEN
		INSERT INTO dav_changes (collection_id, object_key, change_type, resource_name) VALUES (COALESCE(OLD.calendar_id, CONCAT('cal:', OLD.user_id)), OLD.id, 'destroyed', (SELECT name FROM dav_calendar_objects WHERE id = OLD.id));
	END IF;
END;
--> statement-breakpoint
CREATE TRIGGER dav_changes_calendar_events_ad AFTER DELETE ON calendar_events FOR EACH ROW
BEGIN
	IF OLD.dav_object_id IS NOT NULL AND CAST(OLD.dav_object_id AS BINARY) <> CAST(OLD.id AS BINARY) AND EXISTS (SELECT 1 FROM calendar_events WHERE id = OLD.dav_object_id) THEN
		INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES (COALESCE(OLD.calendar_id, CONCAT('cal:', OLD.user_id)), OLD.dav_object_id, 'updated');
	END IF;
END;
