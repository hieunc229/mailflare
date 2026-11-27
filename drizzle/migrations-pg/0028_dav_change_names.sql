ALTER TABLE "dav_changes" ADD COLUMN "resource_name" text;
--> statement-breakpoint
-- A destroyed resource keeps the name it was served under (spec F6-5), so sync-collection can report it gone by that name.
-- The master's row is logged BEFORE its delete: the cascade removes dav_calendar_objects with the event, so after it the name is gone.
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
		IF OLD.dav_object_id <> OLD.id AND EXISTS (SELECT 1 FROM calendar_events WHERE id = OLD.dav_object_id) THEN
			INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES ('cal:' || OLD.user_id, OLD.dav_object_id, 'updated');
		END IF;
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION mailflare_dav_calendar_deleting() RETURNS trigger AS $$
BEGIN
	IF OLD.dav_object_id IS NULL OR OLD.dav_object_id = OLD.id THEN
		INSERT INTO dav_changes (collection_id, object_key, change_type, resource_name)
		VALUES ('cal:' || OLD.user_id, OLD.id, 'destroyed', (SELECT name FROM dav_calendar_objects WHERE id = OLD.id));
	END IF;
	RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER dav_changes_calendar_events_bd BEFORE DELETE ON calendar_events
FOR EACH ROW EXECUTE FUNCTION mailflare_dav_calendar_deleting();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION mailflare_dav_card_changed() RETURNS trigger AS $$
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
		INSERT INTO dav_changes (collection_id, object_key, change_type, resource_name) VALUES (OLD.collection_id, OLD.id, 'destroyed', OLD.name);
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- The per-user storage quota (50 MB of calendar bodies, 20 MB and 5000 cards) is sum(size) over one user's rows: indexes on (user_id, size) answer it from the index alone and still serve every lookup by user_id.
CREATE INDEX "dav_calendar_objects_user_size_idx" ON "dav_calendar_objects" USING btree ("user_id","size");
--> statement-breakpoint
DROP INDEX "dav_calendar_objects_user_idx";
--> statement-breakpoint
CREATE INDEX "dav_cards_user_size_idx" ON "dav_cards" USING btree ("user_id","size");
--> statement-breakpoint
DROP INDEX "dav_cards_user_idx";
