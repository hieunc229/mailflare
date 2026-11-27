ALTER TABLE `calendar_events` ADD `rrule` text;
--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `recurrence_id` integer;
--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `dav_object_id` text;
--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `all_day` integer DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX `calendar_events_dav_object_idx` ON `calendar_events` (`dav_object_id`);
--> statement-breakpoint
-- The change-log triggers now watch the new columns and key a row by its DAV resource, so an override row moves its parent's ETag (spec F6-2 and F6-3).
DROP TRIGGER IF EXISTS `dav_changes_calendar_events_ai`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `dav_changes_calendar_events_au`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `dav_changes_calendar_events_ad`;
--> statement-breakpoint
CREATE TRIGGER `dav_changes_calendar_events_ai` AFTER INSERT ON `calendar_events` BEGIN
	INSERT INTO dav_changes (collection_id, object_key, change_type)
	VALUES ('cal:' || NEW.user_id, coalesce(NEW.dav_object_id, NEW.id), CASE WHEN NEW.dav_object_id IS NULL OR NEW.dav_object_id = NEW.id THEN 'created' ELSE 'updated' END);
END;
--> statement-breakpoint
CREATE TRIGGER `dav_changes_calendar_events_au` AFTER UPDATE ON `calendar_events`
WHEN OLD.user_id <> NEW.user_id OR OLD.mailbox_id IS NOT NEW.mailbox_id OR OLD.title IS NOT NEW.title OR OLD.description IS NOT NEW.description OR OLD.location IS NOT NEW.location OR OLD.attendees IS NOT NEW.attendees OR OLD.color IS NOT NEW.color OR OLD.repeat IS NOT NEW.repeat OR OLD.repeat_days IS NOT NEW.repeat_days OR OLD.excluded_occurrences IS NOT NEW.excluded_occurrences OR OLD.time_zone IS NOT NEW.time_zone OR OLD.response_status IS NOT NEW.response_status OR OLD.invite_message_id IS NOT NEW.invite_message_id OR OLD.invite_sender IS NOT NEW.invite_sender OR OLD.attendee_responses IS NOT NEW.attendee_responses OR OLD.repeat_anchor_day IS NOT NEW.repeat_anchor_day OR OLD.repeat_until IS NOT NEW.repeat_until OR OLD.starts_at IS NOT NEW.starts_at OR OLD.ends_at IS NOT NEW.ends_at OR OLD.reminder_minutes IS NOT NEW.reminder_minutes OR OLD.invite_sequence IS NOT NEW.invite_sequence OR OLD.event_sequence IS NOT NEW.event_sequence OR OLD.repeat_interval IS NOT NEW.repeat_interval OR OLD.repeat_weekday IS NOT NEW.repeat_weekday OR OLD.repeat_week IS NOT NEW.repeat_week OR OLD.updated_at IS NOT NEW.updated_at OR OLD.rrule IS NOT NEW.rrule OR OLD.recurrence_id IS NOT NEW.recurrence_id OR OLD.dav_object_id IS NOT NEW.dav_object_id OR OLD.all_day IS NOT NEW.all_day BEGIN
	INSERT INTO dav_changes (collection_id, object_key, change_type)
	SELECT 'cal:' || OLD.user_id, OLD.id, 'destroyed' WHERE OLD.user_id <> NEW.user_id AND (OLD.dav_object_id IS NULL OR OLD.dav_object_id = OLD.id);
	INSERT INTO dav_changes (collection_id, object_key, change_type)
	VALUES ('cal:' || NEW.user_id, coalesce(NEW.dav_object_id, NEW.id), CASE WHEN OLD.user_id <> NEW.user_id AND (NEW.dav_object_id IS NULL OR NEW.dav_object_id = NEW.id) THEN 'created' ELSE 'updated' END);
	INSERT INTO dav_changes (collection_id, object_key, change_type)
	SELECT 'cal:' || OLD.user_id, coalesce(OLD.dav_object_id, OLD.id), 'updated'
	WHERE OLD.user_id = NEW.user_id AND coalesce(OLD.dav_object_id, OLD.id) <> coalesce(NEW.dav_object_id, NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER `dav_changes_calendar_events_ad` AFTER DELETE ON `calendar_events` BEGIN
	INSERT INTO dav_changes (collection_id, object_key, change_type)
	SELECT 'cal:' || OLD.user_id, OLD.id, 'destroyed' WHERE OLD.dav_object_id IS NULL OR OLD.dav_object_id = OLD.id;
	INSERT INTO dav_changes (collection_id, object_key, change_type)
	SELECT 'cal:' || OLD.user_id, OLD.dav_object_id, 'updated'
	WHERE OLD.dav_object_id <> OLD.id AND EXISTS (SELECT 1 FROM calendar_events WHERE id = OLD.dav_object_id);
END;
