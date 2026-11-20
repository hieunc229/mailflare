ALTER TABLE `calendar_events` ADD `rrule` longtext;
--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `recurrence_id` bigint;
--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `dav_object_id` varchar(191);
--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `all_day` boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX `calendar_events_dav_object_idx` ON `calendar_events` (`dav_object_id`);
--> statement-breakpoint
-- The change-log triggers now watch the new columns and key a row by its DAV resource, so an override row moves its parent's ETag (spec F6-2 and F6-3).
DROP TRIGGER IF EXISTS dav_changes_calendar_events_ai;
--> statement-breakpoint
DROP TRIGGER IF EXISTS dav_changes_calendar_events_au;
--> statement-breakpoint
DROP TRIGGER IF EXISTS dav_changes_calendar_events_ad;
--> statement-breakpoint
CREATE TRIGGER dav_changes_calendar_events_ai AFTER INSERT ON calendar_events FOR EACH ROW
BEGIN
	INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES (CONCAT('cal:', NEW.user_id), COALESCE(NEW.dav_object_id, NEW.id), CASE WHEN NEW.dav_object_id IS NULL OR CAST(NEW.dav_object_id AS BINARY) = CAST(NEW.id AS BINARY) THEN 'created' ELSE 'updated' END);
END;
--> statement-breakpoint
CREATE TRIGGER dav_changes_calendar_events_au AFTER UPDATE ON calendar_events FOR EACH ROW
BEGIN
	IF NOT (CAST(OLD.user_id AS BINARY) <=> CAST(NEW.user_id AS BINARY)) OR NOT (CAST(OLD.mailbox_id AS BINARY) <=> CAST(NEW.mailbox_id AS BINARY) AND CAST(OLD.title AS BINARY) <=> CAST(NEW.title AS BINARY) AND CAST(OLD.description AS BINARY) <=> CAST(NEW.description AS BINARY) AND CAST(OLD.location AS BINARY) <=> CAST(NEW.location AS BINARY) AND CAST(OLD.attendees AS BINARY) <=> CAST(NEW.attendees AS BINARY) AND CAST(OLD.color AS BINARY) <=> CAST(NEW.color AS BINARY) AND CAST(OLD.`repeat` AS BINARY) <=> CAST(NEW.`repeat` AS BINARY) AND CAST(OLD.repeat_days AS BINARY) <=> CAST(NEW.repeat_days AS BINARY) AND CAST(OLD.excluded_occurrences AS BINARY) <=> CAST(NEW.excluded_occurrences AS BINARY) AND CAST(OLD.time_zone AS BINARY) <=> CAST(NEW.time_zone AS BINARY) AND CAST(OLD.response_status AS BINARY) <=> CAST(NEW.response_status AS BINARY) AND CAST(OLD.invite_message_id AS BINARY) <=> CAST(NEW.invite_message_id AS BINARY) AND CAST(OLD.invite_sender AS BINARY) <=> CAST(NEW.invite_sender AS BINARY) AND CAST(OLD.attendee_responses AS BINARY) <=> CAST(NEW.attendee_responses AS BINARY) AND OLD.repeat_anchor_day <=> NEW.repeat_anchor_day AND OLD.repeat_until <=> NEW.repeat_until AND OLD.starts_at <=> NEW.starts_at AND OLD.ends_at <=> NEW.ends_at AND OLD.reminder_minutes <=> NEW.reminder_minutes AND OLD.invite_sequence <=> NEW.invite_sequence AND OLD.updated_at <=> NEW.updated_at AND CAST(OLD.rrule AS BINARY) <=> CAST(NEW.rrule AS BINARY) AND OLD.recurrence_id <=> NEW.recurrence_id AND CAST(OLD.dav_object_id AS BINARY) <=> CAST(NEW.dav_object_id AS BINARY) AND OLD.all_day <=> NEW.all_day) THEN
		IF NOT (CAST(OLD.user_id AS BINARY) <=> CAST(NEW.user_id AS BINARY)) AND (OLD.dav_object_id IS NULL OR CAST(OLD.dav_object_id AS BINARY) = CAST(OLD.id AS BINARY)) THEN
			INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES (CONCAT('cal:', OLD.user_id), OLD.id, 'destroyed');
		END IF;
		INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES (CONCAT('cal:', NEW.user_id), COALESCE(NEW.dav_object_id, NEW.id), CASE WHEN NOT (CAST(OLD.user_id AS BINARY) <=> CAST(NEW.user_id AS BINARY)) AND (NEW.dav_object_id IS NULL OR CAST(NEW.dav_object_id AS BINARY) = CAST(NEW.id AS BINARY)) THEN 'created' ELSE 'updated' END);
		IF CAST(OLD.user_id AS BINARY) <=> CAST(NEW.user_id AS BINARY) AND NOT (CAST(COALESCE(OLD.dav_object_id, OLD.id) AS BINARY) <=> CAST(COALESCE(NEW.dav_object_id, NEW.id) AS BINARY)) THEN
			INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES (CONCAT('cal:', OLD.user_id), COALESCE(OLD.dav_object_id, OLD.id), 'updated');
		END IF;
	END IF;
END;
--> statement-breakpoint
CREATE TRIGGER dav_changes_calendar_events_ad AFTER DELETE ON calendar_events FOR EACH ROW
BEGIN
	IF OLD.dav_object_id IS NULL OR CAST(OLD.dav_object_id AS BINARY) = CAST(OLD.id AS BINARY) THEN
		INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES (CONCAT('cal:', OLD.user_id), OLD.id, 'destroyed');
	ELSEIF EXISTS (SELECT 1 FROM calendar_events WHERE id = OLD.dav_object_id) THEN
		INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES (CONCAT('cal:', OLD.user_id), OLD.dav_object_id, 'updated');
	END IF;
END;
