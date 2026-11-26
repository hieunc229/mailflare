ALTER TABLE "calendar_events" ADD COLUMN "calendar_id" text;
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "is_private" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "transparent" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX "calendar_events_calendar_starts_idx" ON "calendar_events" USING btree ("calendar_id","starts_at");
--> statement-breakpoint
CREATE TABLE "calendar_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"calendar_id" text NOT NULL,
	"grantee_user_id" text,
	"role" text NOT NULL,
	"created_by_user_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_resources" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'room' NOT NULL,
	"capacity" bigint,
	"location" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_by_user_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_resource_bookings" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_id" text NOT NULL,
	"event_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_shares" ADD CONSTRAINT "calendar_shares_calendar_id_dav_collections_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."dav_collections"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "calendar_shares" ADD CONSTRAINT "calendar_shares_grantee_user_id_users_id_fk" FOREIGN KEY ("grantee_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "calendar_shares" ADD CONSTRAINT "calendar_shares_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "calendar_resources" ADD CONSTRAINT "calendar_resources_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "calendar_resource_bookings" ADD CONSTRAINT "calendar_resource_bookings_resource_id_calendar_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."calendar_resources"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "calendar_resource_bookings" ADD CONSTRAINT "calendar_resource_bookings_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_shares_calendar_grantee_idx" ON "calendar_shares" USING btree ("calendar_id","grantee_user_id");
--> statement-breakpoint
CREATE INDEX "calendar_shares_grantee_idx" ON "calendar_shares" USING btree ("grantee_user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_resources_name_idx" ON "calendar_resources" USING btree ("name");
--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_resource_bookings_resource_event_idx" ON "calendar_resource_bookings" USING btree ("resource_id","event_id");
--> statement-breakpoint
CREATE INDEX "calendar_resource_bookings_resource_status_idx" ON "calendar_resource_bookings" USING btree ("resource_id","status");
--> statement-breakpoint
CREATE INDEX "calendar_resource_bookings_event_idx" ON "calendar_resource_bookings" USING btree ("event_id");
--> statement-breakpoint
-- The change-log triggers key a row by its calendar's collection: calendar_id, else the owner's default calendar `cal:<user_id>` (spec F9 8.2).
-- Existing rows have a null calendar_id, so every one still resolves to the collection it had; the migration writes no dav_changes rows.
-- A row that moves between collections is destroyed (under the name it was served by) in the old one and created in the new one.
-- Rows are never moved by a foreign-key cascade (MySQL fires no triggers for those): a calendar's events are deleted by statement first.
CREATE OR REPLACE FUNCTION mailflare_dav_calendar_changed() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		INSERT INTO dav_changes (collection_id, object_key, change_type)
		VALUES (coalesce(NEW.calendar_id, 'cal:' || NEW.user_id), coalesce(NEW.dav_object_id, NEW.id), CASE WHEN NEW.dav_object_id IS NULL OR NEW.dav_object_id = NEW.id THEN 'created' ELSE 'updated' END);
	ELSIF TG_OP = 'UPDATE' THEN
		IF coalesce(OLD.calendar_id, 'cal:' || OLD.user_id) <> coalesce(NEW.calendar_id, 'cal:' || NEW.user_id) AND (OLD.dav_object_id IS NULL OR OLD.dav_object_id = OLD.id) THEN
			INSERT INTO dav_changes (collection_id, object_key, change_type, resource_name)
			VALUES (coalesce(OLD.calendar_id, 'cal:' || OLD.user_id), OLD.id, 'destroyed', (SELECT name FROM dav_calendar_objects WHERE id = OLD.id));
		END IF;
		INSERT INTO dav_changes (collection_id, object_key, change_type)
		VALUES (coalesce(NEW.calendar_id, 'cal:' || NEW.user_id), coalesce(NEW.dav_object_id, NEW.id), CASE WHEN coalesce(OLD.calendar_id, 'cal:' || OLD.user_id) <> coalesce(NEW.calendar_id, 'cal:' || NEW.user_id) AND (NEW.dav_object_id IS NULL OR NEW.dav_object_id = NEW.id) THEN 'created' ELSE 'updated' END);
		IF (coalesce(OLD.calendar_id, 'cal:' || OLD.user_id) = coalesce(NEW.calendar_id, 'cal:' || NEW.user_id) AND coalesce(OLD.dav_object_id, OLD.id) <> coalesce(NEW.dav_object_id, NEW.id))
			OR (coalesce(OLD.calendar_id, 'cal:' || OLD.user_id) <> coalesce(NEW.calendar_id, 'cal:' || NEW.user_id) AND OLD.dav_object_id IS NOT NULL AND OLD.dav_object_id <> OLD.id) THEN
			INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES (coalesce(OLD.calendar_id, 'cal:' || OLD.user_id), coalesce(OLD.dav_object_id, OLD.id), 'updated');
		END IF;
	ELSE
		IF OLD.dav_object_id <> OLD.id AND EXISTS (SELECT 1 FROM calendar_events WHERE id = OLD.dav_object_id) THEN
			INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES (coalesce(OLD.calendar_id, 'cal:' || OLD.user_id), OLD.dav_object_id, 'updated');
		END IF;
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION mailflare_dav_calendar_deleting() RETURNS trigger AS $$
BEGIN
	IF OLD.dav_object_id IS NULL OR OLD.dav_object_id = OLD.id THEN
		INSERT INTO dav_changes (collection_id, object_key, change_type, resource_name)
		VALUES (coalesce(OLD.calendar_id, 'cal:' || OLD.user_id), OLD.id, 'destroyed', (SELECT name FROM dav_calendar_objects WHERE id = OLD.id));
	END IF;
	RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS dav_changes_calendar_events_au ON calendar_events;
--> statement-breakpoint
CREATE TRIGGER dav_changes_calendar_events_au AFTER UPDATE ON calendar_events
FOR EACH ROW WHEN (OLD.user_id <> NEW.user_id OR (OLD.calendar_id, OLD.is_private, OLD.transparent, OLD.mailbox_id, OLD.title, OLD.description, OLD.location, OLD.attendees, OLD.color, OLD.repeat, OLD.repeat_days, OLD.excluded_occurrences, OLD.time_zone, OLD.response_status, OLD.invite_message_id, OLD.invite_sender, OLD.attendee_responses, OLD.repeat_anchor_day, OLD.repeat_until, OLD.starts_at, OLD.ends_at, OLD.reminder_minutes, OLD.invite_sequence, OLD.updated_at, OLD.rrule, OLD.recurrence_id, OLD.dav_object_id, OLD.all_day) IS DISTINCT FROM (NEW.calendar_id, NEW.is_private, NEW.transparent, NEW.mailbox_id, NEW.title, NEW.description, NEW.location, NEW.attendees, NEW.color, NEW.repeat, NEW.repeat_days, NEW.excluded_occurrences, NEW.time_zone, NEW.response_status, NEW.invite_message_id, NEW.invite_sender, NEW.attendee_responses, NEW.repeat_anchor_day, NEW.repeat_until, NEW.starts_at, NEW.ends_at, NEW.reminder_minutes, NEW.invite_sequence, NEW.updated_at, NEW.rrule, NEW.recurrence_id, NEW.dav_object_id, NEW.all_day)) EXECUTE FUNCTION mailflare_dav_calendar_changed();
