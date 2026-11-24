CREATE TABLE `dav_collections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`display_name` text,
	`color` text,
	`description` text,
	`sort_order` integer,
	`dead_props` text DEFAULT '{}' NOT NULL,
	`seeded_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `dav_collections_user_idx` ON `dav_collections` (`user_id`);
--> statement-breakpoint
CREATE TABLE `dav_calendar_objects` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`name` text NOT NULL,
	`uid` text NOT NULL,
	`body` text,
	`rows_hash` text,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `calendar_events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dav_calendar_objects_name_idx` ON `dav_calendar_objects` (`collection_id`,`name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `dav_calendar_objects_uid_idx` ON `dav_calendar_objects` (`collection_id`,`uid`);
--> statement-breakpoint
CREATE INDEX `dav_calendar_objects_user_idx` ON `dav_calendar_objects` (`user_id`);
--> statement-breakpoint
CREATE TABLE `dav_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`name` text NOT NULL,
	`uid` text NOT NULL,
	`body` text NOT NULL,
	`version` text NOT NULL,
	`fn` text DEFAULT '' NOT NULL,
	`emails` text DEFAULT '[]' NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dav_cards_name_idx` ON `dav_cards` (`collection_id`,`name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `dav_cards_uid_idx` ON `dav_cards` (`collection_id`,`uid`);
--> statement-breakpoint
CREATE INDEX `dav_cards_user_idx` ON `dav_cards` (`user_id`);
--> statement-breakpoint
CREATE TABLE `dav_changes` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`collection_id` text NOT NULL,
	`object_key` text NOT NULL,
	`change_type` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `dav_changes_collection_seq_idx` ON `dav_changes` (`collection_id`,`seq`);
--> statement-breakpoint
CREATE INDEX `dav_changes_object_idx` ON `dav_changes` (`collection_id`,`object_key`,`seq`);
--> statement-breakpoint
CREATE TABLE `dav_sync_state` (
	`collection_id` text PRIMARY KEY NOT NULL,
	`epoch` text NOT NULL,
	`floor` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
-- Calendar changes and card changes feed the DAV change log (spec F6-3); the resource ETag and sync token derive from it.
CREATE TRIGGER `dav_changes_calendar_events_ai` AFTER INSERT ON `calendar_events` BEGIN
	INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES ('cal:' || NEW.user_id, NEW.id, 'created');
END;
--> statement-breakpoint
CREATE TRIGGER `dav_changes_calendar_events_au` AFTER UPDATE ON `calendar_events`
WHEN OLD.user_id <> NEW.user_id OR OLD.mailbox_id IS NOT NEW.mailbox_id OR OLD.title IS NOT NEW.title OR OLD.description IS NOT NEW.description OR OLD.location IS NOT NEW.location OR OLD.attendees IS NOT NEW.attendees OR OLD.color IS NOT NEW.color OR OLD.repeat IS NOT NEW.repeat OR OLD.repeat_days IS NOT NEW.repeat_days OR OLD.excluded_occurrences IS NOT NEW.excluded_occurrences OR OLD.time_zone IS NOT NEW.time_zone OR OLD.response_status IS NOT NEW.response_status OR OLD.invite_message_id IS NOT NEW.invite_message_id OR OLD.invite_sender IS NOT NEW.invite_sender OR OLD.attendee_responses IS NOT NEW.attendee_responses OR OLD.repeat_anchor_day IS NOT NEW.repeat_anchor_day OR OLD.repeat_until IS NOT NEW.repeat_until OR OLD.starts_at IS NOT NEW.starts_at OR OLD.ends_at IS NOT NEW.ends_at OR OLD.reminder_minutes IS NOT NEW.reminder_minutes OR OLD.invite_sequence IS NOT NEW.invite_sequence OR OLD.event_sequence IS NOT NEW.event_sequence OR OLD.repeat_interval IS NOT NEW.repeat_interval OR OLD.repeat_weekday IS NOT NEW.repeat_weekday OR OLD.repeat_week IS NOT NEW.repeat_week OR OLD.updated_at IS NOT NEW.updated_at BEGIN
	INSERT INTO dav_changes (collection_id, object_key, change_type)
	SELECT 'cal:' || OLD.user_id, OLD.id, 'destroyed' WHERE OLD.user_id <> NEW.user_id;
	INSERT INTO dav_changes (collection_id, object_key, change_type)
	VALUES ('cal:' || NEW.user_id, NEW.id, CASE WHEN OLD.user_id <> NEW.user_id THEN 'created' ELSE 'updated' END);
END;
--> statement-breakpoint
CREATE TRIGGER `dav_changes_calendar_events_ad` AFTER DELETE ON `calendar_events` BEGIN
	INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES ('cal:' || OLD.user_id, OLD.id, 'destroyed');
END;
--> statement-breakpoint
CREATE TRIGGER `dav_changes_cards_ai` AFTER INSERT ON `dav_cards` BEGIN
	INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES (NEW.collection_id, NEW.id, 'created');
END;
--> statement-breakpoint
CREATE TRIGGER `dav_changes_cards_au` AFTER UPDATE ON `dav_cards`
WHEN OLD.collection_id <> NEW.collection_id OR OLD.name IS NOT NEW.name OR OLD.uid IS NOT NEW.uid OR OLD.body IS NOT NEW.body OR OLD.version IS NOT NEW.version OR OLD.fn IS NOT NEW.fn OR OLD.emails IS NOT NEW.emails OR OLD.size IS NOT NEW.size OR OLD.updated_at IS NOT NEW.updated_at BEGIN
	INSERT INTO dav_changes (collection_id, object_key, change_type)
	SELECT OLD.collection_id, OLD.id, 'destroyed' WHERE OLD.collection_id <> NEW.collection_id;
	INSERT INTO dav_changes (collection_id, object_key, change_type)
	VALUES (NEW.collection_id, NEW.id, CASE WHEN OLD.collection_id <> NEW.collection_id THEN 'created' ELSE 'updated' END);
END;
--> statement-breakpoint
CREATE TRIGGER `dav_changes_cards_ad` AFTER DELETE ON `dav_cards` BEGIN
	INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES (OLD.collection_id, OLD.id, 'destroyed');
END;
--> statement-breakpoint
INSERT INTO dav_changes (collection_id, object_key, change_type)
SELECT 'cal:' || user_id, id, 'created' FROM calendar_events ORDER BY created_at, id;
