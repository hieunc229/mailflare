CREATE TABLE "dav_calendar_objects" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"collection_id" text NOT NULL,
	"name" text NOT NULL,
	"uid" text NOT NULL,
	"body" text,
	"rows_hash" text,
	"size" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dav_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"collection_id" text NOT NULL,
	"name" text NOT NULL,
	"uid" text NOT NULL,
	"body" text NOT NULL,
	"version" text NOT NULL,
	"fn" text DEFAULT '' NOT NULL,
	"emails" text DEFAULT '[]' NOT NULL,
	"size" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dav_changes" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"collection_id" text NOT NULL,
	"object_key" text NOT NULL,
	"change_type" text NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dav_collections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"display_name" text,
	"color" text,
	"description" text,
	"sort_order" bigint,
	"dead_props" text DEFAULT '{}' NOT NULL,
	"seeded_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dav_sync_state" (
	"collection_id" text PRIMARY KEY NOT NULL,
	"epoch" text NOT NULL,
	"floor" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dav_calendar_objects" ADD CONSTRAINT "dav_calendar_objects_id_calendar_events_id_fk" FOREIGN KEY ("id") REFERENCES "public"."calendar_events"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "dav_cards" ADD CONSTRAINT "dav_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "dav_collections" ADD CONSTRAINT "dav_collections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "dav_calendar_objects_name_idx" ON "dav_calendar_objects" USING btree ("collection_id","name");
--> statement-breakpoint
CREATE UNIQUE INDEX "dav_calendar_objects_uid_idx" ON "dav_calendar_objects" USING btree ("collection_id","uid");
--> statement-breakpoint
CREATE INDEX "dav_calendar_objects_user_idx" ON "dav_calendar_objects" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "dav_cards_name_idx" ON "dav_cards" USING btree ("collection_id","name");
--> statement-breakpoint
CREATE UNIQUE INDEX "dav_cards_uid_idx" ON "dav_cards" USING btree ("collection_id","uid");
--> statement-breakpoint
CREATE INDEX "dav_cards_user_idx" ON "dav_cards" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "dav_changes_collection_seq_idx" ON "dav_changes" USING btree ("collection_id","seq");
--> statement-breakpoint
CREATE INDEX "dav_changes_object_idx" ON "dav_changes" USING btree ("collection_id","object_key","seq");
--> statement-breakpoint
CREATE INDEX "dav_collections_user_idx" ON "dav_collections" USING btree ("user_id");
--> statement-breakpoint
CREATE FUNCTION mailflare_dav_calendar_changed() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES ('cal:' || NEW.user_id, NEW.id, 'created');
	ELSIF TG_OP = 'UPDATE' THEN
		IF OLD.user_id <> NEW.user_id THEN
			INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES ('cal:' || OLD.user_id, OLD.id, 'destroyed');
		END IF;
		INSERT INTO dav_changes (collection_id, object_key, change_type)
		VALUES ('cal:' || NEW.user_id, NEW.id, CASE WHEN OLD.user_id <> NEW.user_id THEN 'created' ELSE 'updated' END);
	ELSE
		INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES ('cal:' || OLD.user_id, OLD.id, 'destroyed');
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER dav_changes_calendar_events_ai AFTER INSERT ON calendar_events
FOR EACH ROW EXECUTE FUNCTION mailflare_dav_calendar_changed();
--> statement-breakpoint
CREATE TRIGGER dav_changes_calendar_events_au AFTER UPDATE ON calendar_events
FOR EACH ROW WHEN (OLD.user_id <> NEW.user_id OR (OLD.mailbox_id, OLD.title, OLD.description, OLD.location, OLD.attendees, OLD.color, OLD.repeat, OLD.repeat_days, OLD.excluded_occurrences, OLD.time_zone, OLD.response_status, OLD.invite_message_id, OLD.invite_sender, OLD.attendee_responses, OLD.repeat_anchor_day, OLD.repeat_until, OLD.starts_at, OLD.ends_at, OLD.reminder_minutes, OLD.invite_sequence, OLD.event_sequence, OLD.repeat_interval, OLD.repeat_weekday, OLD.repeat_week, OLD.updated_at) IS DISTINCT FROM (NEW.mailbox_id, NEW.title, NEW.description, NEW.location, NEW.attendees, NEW.color, NEW.repeat, NEW.repeat_days, NEW.excluded_occurrences, NEW.time_zone, NEW.response_status, NEW.invite_message_id, NEW.invite_sender, NEW.attendee_responses, NEW.repeat_anchor_day, NEW.repeat_until, NEW.starts_at, NEW.ends_at, NEW.reminder_minutes, NEW.invite_sequence, NEW.event_sequence, NEW.repeat_interval, NEW.repeat_weekday, NEW.repeat_week, NEW.updated_at)) EXECUTE FUNCTION mailflare_dav_calendar_changed();
--> statement-breakpoint
CREATE TRIGGER dav_changes_calendar_events_ad AFTER DELETE ON calendar_events
FOR EACH ROW EXECUTE FUNCTION mailflare_dav_calendar_changed();
--> statement-breakpoint
CREATE FUNCTION mailflare_dav_card_changed() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES (NEW.collection_id, NEW.id, 'created');
	ELSIF TG_OP = 'UPDATE' THEN
		IF OLD.collection_id <> NEW.collection_id THEN
			INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES (OLD.collection_id, OLD.id, 'destroyed');
		END IF;
		INSERT INTO dav_changes (collection_id, object_key, change_type)
		VALUES (NEW.collection_id, NEW.id, CASE WHEN OLD.collection_id <> NEW.collection_id THEN 'created' ELSE 'updated' END);
	ELSE
		INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES (OLD.collection_id, OLD.id, 'destroyed');
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER dav_changes_cards_aid AFTER INSERT OR DELETE ON dav_cards
FOR EACH ROW EXECUTE FUNCTION mailflare_dav_card_changed();
--> statement-breakpoint
CREATE TRIGGER dav_changes_cards_au AFTER UPDATE ON dav_cards
FOR EACH ROW WHEN ((OLD.collection_id, OLD.name, OLD.uid, OLD.body, OLD.version, OLD.fn, OLD.emails, OLD.size, OLD.updated_at) IS DISTINCT FROM (NEW.collection_id, NEW.name, NEW.uid, NEW.body, NEW.version, NEW.fn, NEW.emails, NEW.size, NEW.updated_at)) EXECUTE FUNCTION mailflare_dav_card_changed();
--> statement-breakpoint
INSERT INTO dav_changes (collection_id, object_key, change_type)
SELECT 'cal:' || user_id, id, 'created' FROM calendar_events ORDER BY created_at, id;
