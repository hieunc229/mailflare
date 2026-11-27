ALTER TABLE "calendar_events" ADD COLUMN "rrule" text;
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "recurrence_id" bigint;
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "dav_object_id" text;
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "all_day" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX "calendar_events_dav_object_idx" ON "calendar_events" USING btree ("dav_object_id");
--> statement-breakpoint
-- The change-log triggers now watch the new columns and key a row by its DAV resource, so an override row moves its parent's ETag (spec F6-2 and F6-3).
DROP TRIGGER IF EXISTS dav_changes_calendar_events_ai ON calendar_events;
--> statement-breakpoint
DROP TRIGGER IF EXISTS dav_changes_calendar_events_au ON calendar_events;
--> statement-breakpoint
DROP TRIGGER IF EXISTS dav_changes_calendar_events_ad ON calendar_events;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION mailflare_dav_calendar_changed() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		INSERT INTO dav_changes (collection_id, object_key, change_type)
		VALUES ('cal:' || NEW.user_id, coalesce(NEW.dav_object_id, NEW.id), CASE WHEN NEW.dav_object_id IS NULL OR NEW.dav_object_id = NEW.id THEN 'created' ELSE 'updated' END);
	ELSIF TG_OP = 'UPDATE' THEN
		IF OLD.user_id <> NEW.user_id AND (OLD.dav_object_id IS NULL OR OLD.dav_object_id = OLD.id) THEN
			INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES ('cal:' || OLD.user_id, OLD.id, 'destroyed');
		END IF;
		INSERT INTO dav_changes (collection_id, object_key, change_type)
		VALUES ('cal:' || NEW.user_id, coalesce(NEW.dav_object_id, NEW.id), CASE WHEN OLD.user_id <> NEW.user_id AND (NEW.dav_object_id IS NULL OR NEW.dav_object_id = NEW.id) THEN 'created' ELSE 'updated' END);
		IF OLD.user_id = NEW.user_id AND coalesce(OLD.dav_object_id, OLD.id) <> coalesce(NEW.dav_object_id, NEW.id) THEN
			INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES ('cal:' || OLD.user_id, coalesce(OLD.dav_object_id, OLD.id), 'updated');
		END IF;
	ELSE
		IF OLD.dav_object_id IS NULL OR OLD.dav_object_id = OLD.id THEN
			INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES ('cal:' || OLD.user_id, OLD.id, 'destroyed');
		ELSIF EXISTS (SELECT 1 FROM calendar_events WHERE id = OLD.dav_object_id) THEN
			INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES ('cal:' || OLD.user_id, OLD.dav_object_id, 'updated');
		END IF;
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER dav_changes_calendar_events_ai AFTER INSERT ON calendar_events
FOR EACH ROW EXECUTE FUNCTION mailflare_dav_calendar_changed();
--> statement-breakpoint
CREATE TRIGGER dav_changes_calendar_events_au AFTER UPDATE ON calendar_events
FOR EACH ROW WHEN (OLD.user_id <> NEW.user_id OR (OLD.mailbox_id, OLD.title, OLD.description, OLD.location, OLD.attendees, OLD.color, OLD.repeat, OLD.repeat_days, OLD.excluded_occurrences, OLD.time_zone, OLD.response_status, OLD.invite_message_id, OLD.invite_sender, OLD.attendee_responses, OLD.repeat_anchor_day, OLD.repeat_until, OLD.starts_at, OLD.ends_at, OLD.reminder_minutes, OLD.invite_sequence, OLD.event_sequence, OLD.repeat_interval, OLD.repeat_weekday, OLD.repeat_week, OLD.updated_at, OLD.rrule, OLD.recurrence_id, OLD.dav_object_id, OLD.all_day) IS DISTINCT FROM (NEW.mailbox_id, NEW.title, NEW.description, NEW.location, NEW.attendees, NEW.color, NEW.repeat, NEW.repeat_days, NEW.excluded_occurrences, NEW.time_zone, NEW.response_status, NEW.invite_message_id, NEW.invite_sender, NEW.attendee_responses, NEW.repeat_anchor_day, NEW.repeat_until, NEW.starts_at, NEW.ends_at, NEW.reminder_minutes, NEW.invite_sequence, NEW.event_sequence, NEW.repeat_interval, NEW.repeat_weekday, NEW.repeat_week, NEW.updated_at, NEW.rrule, NEW.recurrence_id, NEW.dav_object_id, NEW.all_day)) EXECUTE FUNCTION mailflare_dav_calendar_changed();
--> statement-breakpoint
CREATE TRIGGER dav_changes_calendar_events_ad AFTER DELETE ON calendar_events
FOR EACH ROW EXECUTE FUNCTION mailflare_dav_calendar_changed();
