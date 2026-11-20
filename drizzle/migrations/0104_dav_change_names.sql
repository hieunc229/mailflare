ALTER TABLE `dav_changes` ADD `resource_name` text;
--> statement-breakpoint
-- A destroyed resource keeps the name it was served under (spec F6-5), so sync-collection can report it gone by that name.
-- The master's row is logged BEFORE its delete: the cascade removes dav_calendar_objects with the event, so after it the name is gone.
DROP TRIGGER IF EXISTS `dav_changes_calendar_events_ad`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `dav_changes_cards_ad`;
--> statement-breakpoint
CREATE TRIGGER `dav_changes_calendar_events_bd` BEFORE DELETE ON `calendar_events` BEGIN
	INSERT INTO dav_changes (collection_id, object_key, change_type, resource_name)
	SELECT 'cal:' || OLD.user_id, OLD.id, 'destroyed', (SELECT name FROM dav_calendar_objects WHERE id = OLD.id) WHERE OLD.dav_object_id IS NULL OR OLD.dav_object_id = OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER `dav_changes_calendar_events_ad` AFTER DELETE ON `calendar_events` BEGIN
	INSERT INTO dav_changes (collection_id, object_key, change_type)
	SELECT 'cal:' || OLD.user_id, OLD.dav_object_id, 'updated'
	WHERE OLD.dav_object_id <> OLD.id AND EXISTS (SELECT 1 FROM calendar_events WHERE id = OLD.dav_object_id);
END;
--> statement-breakpoint
CREATE TRIGGER `dav_changes_cards_ad` AFTER DELETE ON `dav_cards` BEGIN
	INSERT INTO dav_changes (collection_id, object_key, change_type, resource_name) VALUES (OLD.collection_id, OLD.id, 'destroyed', OLD.name);
END;
--> statement-breakpoint
-- The per-user storage quota (50 MB of calendar bodies, 20 MB and 5000 cards) is sum(size) over one user's rows: indexes on (user_id, size) answer it from the index alone and still serve every lookup by user_id.
CREATE INDEX `dav_calendar_objects_user_size_idx` ON `dav_calendar_objects` (`user_id`,`size`);
--> statement-breakpoint
DROP INDEX `dav_calendar_objects_user_idx`;
--> statement-breakpoint
CREATE INDEX `dav_cards_user_size_idx` ON `dav_cards` (`user_id`,`size`);
--> statement-breakpoint
DROP INDEX `dav_cards_user_idx`;
