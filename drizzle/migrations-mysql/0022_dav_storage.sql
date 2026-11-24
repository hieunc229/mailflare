CREATE TABLE `dav_calendar_objects` (
	`id` varchar(191) NOT NULL,
	`user_id` varchar(191) NOT NULL,
	`collection_id` varchar(191) NOT NULL,
	`name` varchar(255) NOT NULL,
	`uid` varchar(191) NOT NULL,
	`body` longtext,
	`rows_hash` longtext,
	`size` bigint NOT NULL,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `dav_calendar_objects_id` PRIMARY KEY(`id`),
	CONSTRAINT `dav_calendar_objects_name_idx` UNIQUE(`collection_id`,`name`),
	CONSTRAINT `dav_calendar_objects_uid_idx` UNIQUE(`collection_id`,`uid`)
);
--> statement-breakpoint
CREATE TABLE `dav_cards` (
	`id` varchar(191) NOT NULL,
	`user_id` varchar(191) NOT NULL,
	`collection_id` varchar(191) NOT NULL,
	`name` varchar(255) NOT NULL,
	`uid` varchar(191) NOT NULL,
	`body` longtext NOT NULL,
	`version` varchar(64) NOT NULL,
	`fn` longtext NOT NULL DEFAULT (''),
	`emails` longtext NOT NULL DEFAULT ('[]'),
	`size` bigint NOT NULL,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `dav_cards_id` PRIMARY KEY(`id`),
	CONSTRAINT `dav_cards_name_idx` UNIQUE(`collection_id`,`name`),
	CONSTRAINT `dav_cards_uid_idx` UNIQUE(`collection_id`,`uid`)
);
--> statement-breakpoint
CREATE TABLE `dav_changes` (
	`seq` bigint AUTO_INCREMENT NOT NULL,
	`collection_id` varchar(191) NOT NULL,
	`object_key` varchar(191) NOT NULL,
	`change_type` varchar(64) NOT NULL,
	`created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
	CONSTRAINT `dav_changes_seq` PRIMARY KEY(`seq`)
);
--> statement-breakpoint
CREATE TABLE `dav_collections` (
	`id` varchar(191) NOT NULL,
	`user_id` varchar(191) NOT NULL,
	`kind` varchar(64) NOT NULL,
	`display_name` longtext,
	`color` longtext,
	`description` longtext,
	`sort_order` bigint,
	`dead_props` longtext NOT NULL DEFAULT ('{}'),
	`seeded_at` bigint,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `dav_collections_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `dav_sync_state` (
	`collection_id` varchar(191) NOT NULL,
	`epoch` longtext NOT NULL,
	`floor` bigint NOT NULL DEFAULT 0,
	CONSTRAINT `dav_sync_state_collection_id` PRIMARY KEY(`collection_id`)
);
--> statement-breakpoint
ALTER TABLE `dav_calendar_objects` ADD CONSTRAINT `dav_calendar_objects_id_calendar_events_id_fk` FOREIGN KEY (`id`) REFERENCES `calendar_events`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `dav_cards` ADD CONSTRAINT `dav_cards_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `dav_collections` ADD CONSTRAINT `dav_collections_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `dav_calendar_objects_user_idx` ON `dav_calendar_objects` (`user_id`);
--> statement-breakpoint
CREATE INDEX `dav_cards_user_idx` ON `dav_cards` (`user_id`);
--> statement-breakpoint
CREATE INDEX `dav_changes_collection_seq_idx` ON `dav_changes` (`collection_id`,`seq`);
--> statement-breakpoint
CREATE INDEX `dav_changes_object_idx` ON `dav_changes` (`collection_id`,`object_key`,`seq`);
--> statement-breakpoint
CREATE INDEX `dav_collections_user_idx` ON `dav_collections` (`user_id`);
--> statement-breakpoint
CREATE TRIGGER dav_changes_calendar_events_ai AFTER INSERT ON calendar_events FOR EACH ROW
BEGIN
	INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES (CONCAT('cal:', NEW.user_id), NEW.id, 'created');
END;
--> statement-breakpoint
CREATE TRIGGER dav_changes_calendar_events_au AFTER UPDATE ON calendar_events FOR EACH ROW
BEGIN
	IF NOT (CAST(OLD.user_id AS BINARY) <=> CAST(NEW.user_id AS BINARY)) OR NOT (CAST(OLD.mailbox_id AS BINARY) <=> CAST(NEW.mailbox_id AS BINARY) AND CAST(OLD.title AS BINARY) <=> CAST(NEW.title AS BINARY) AND CAST(OLD.description AS BINARY) <=> CAST(NEW.description AS BINARY) AND CAST(OLD.location AS BINARY) <=> CAST(NEW.location AS BINARY) AND CAST(OLD.attendees AS BINARY) <=> CAST(NEW.attendees AS BINARY) AND CAST(OLD.color AS BINARY) <=> CAST(NEW.color AS BINARY) AND CAST(OLD.`repeat` AS BINARY) <=> CAST(NEW.`repeat` AS BINARY) AND CAST(OLD.repeat_days AS BINARY) <=> CAST(NEW.repeat_days AS BINARY) AND CAST(OLD.excluded_occurrences AS BINARY) <=> CAST(NEW.excluded_occurrences AS BINARY) AND CAST(OLD.time_zone AS BINARY) <=> CAST(NEW.time_zone AS BINARY) AND CAST(OLD.response_status AS BINARY) <=> CAST(NEW.response_status AS BINARY) AND CAST(OLD.invite_message_id AS BINARY) <=> CAST(NEW.invite_message_id AS BINARY) AND CAST(OLD.invite_sender AS BINARY) <=> CAST(NEW.invite_sender AS BINARY) AND CAST(OLD.attendee_responses AS BINARY) <=> CAST(NEW.attendee_responses AS BINARY) AND OLD.repeat_anchor_day <=> NEW.repeat_anchor_day AND OLD.repeat_until <=> NEW.repeat_until AND OLD.starts_at <=> NEW.starts_at AND OLD.ends_at <=> NEW.ends_at AND OLD.reminder_minutes <=> NEW.reminder_minutes AND OLD.invite_sequence <=> NEW.invite_sequence AND OLD.event_sequence <=> NEW.event_sequence AND OLD.repeat_interval <=> NEW.repeat_interval AND OLD.repeat_weekday <=> NEW.repeat_weekday AND OLD.repeat_week <=> NEW.repeat_week AND OLD.updated_at <=> NEW.updated_at) THEN
		IF NOT (CAST(OLD.user_id AS BINARY) <=> CAST(NEW.user_id AS BINARY)) THEN
			INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES (CONCAT('cal:', OLD.user_id), OLD.id, 'destroyed');
			INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES (CONCAT('cal:', NEW.user_id), NEW.id, 'created');
		ELSE
			INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES (CONCAT('cal:', NEW.user_id), NEW.id, 'updated');
		END IF;
	END IF;
END;
--> statement-breakpoint
CREATE TRIGGER dav_changes_calendar_events_ad AFTER DELETE ON calendar_events FOR EACH ROW
BEGIN
	INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES (CONCAT('cal:', OLD.user_id), OLD.id, 'destroyed');
END;
--> statement-breakpoint
CREATE TRIGGER dav_changes_cards_ai AFTER INSERT ON dav_cards FOR EACH ROW
BEGIN
	INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES (NEW.collection_id, NEW.id, 'created');
END;
--> statement-breakpoint
CREATE TRIGGER dav_changes_cards_au AFTER UPDATE ON dav_cards FOR EACH ROW
BEGIN
	IF NOT (CAST(OLD.collection_id AS BINARY) <=> CAST(NEW.collection_id AS BINARY)) OR NOT (CAST(OLD.name AS BINARY) <=> CAST(NEW.name AS BINARY) AND CAST(OLD.uid AS BINARY) <=> CAST(NEW.uid AS BINARY) AND CAST(OLD.body AS BINARY) <=> CAST(NEW.body AS BINARY) AND CAST(OLD.version AS BINARY) <=> CAST(NEW.version AS BINARY) AND CAST(OLD.fn AS BINARY) <=> CAST(NEW.fn AS BINARY) AND CAST(OLD.emails AS BINARY) <=> CAST(NEW.emails AS BINARY) AND OLD.size <=> NEW.size AND OLD.updated_at <=> NEW.updated_at) THEN
		IF NOT (CAST(OLD.collection_id AS BINARY) <=> CAST(NEW.collection_id AS BINARY)) THEN
			INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES (OLD.collection_id, OLD.id, 'destroyed');
			INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES (NEW.collection_id, NEW.id, 'created');
		ELSE
			INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES (NEW.collection_id, NEW.id, 'updated');
		END IF;
	END IF;
END;
--> statement-breakpoint
CREATE TRIGGER dav_changes_cards_ad AFTER DELETE ON dav_cards FOR EACH ROW
BEGIN
	INSERT INTO dav_changes (collection_id, object_key, change_type) VALUES (OLD.collection_id, OLD.id, 'destroyed');
END;
--> statement-breakpoint
INSERT INTO dav_changes (collection_id, object_key, change_type)
SELECT CONCAT('cal:', user_id), id, 'created' FROM calendar_events ORDER BY created_at, id;
