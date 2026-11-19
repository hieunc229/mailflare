-- messages.private_draft: whether the row is an unsent draft, which only its author may see wherever it has been moved.
ALTER TABLE `messages` ADD `private_draft` boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Existing rows: every draft, plus outbound mail in Trash, Archive or the inbox that was never submitted for sending (a draft its author moved).
-- Nothing recorded the move, so this errs towards hiding.
UPDATE `messages` SET `private_draft` = true
WHERE `status` = 'draft'
	OR (`direction` = 'outbound'
		AND `status` IN ('trash', 'received', 'archived')
		AND NOT EXISTS (SELECT 1 FROM `outbound_jobs` WHERE `outbound_jobs`.`message_id` = `messages`.`id`));
--> statement-breakpoint
-- messages_nav_cover_idx and messages_counts_cover_idx keep their MySQL definitions: with utf8mb4 varchar(191) keys the key-length budget in src/db/schema/kits.ts (fitColumns) already stops before user_id, so the draft-filter columns cannot be added there.
-- JMAP clients may hold other users' drafts in their cache. The backfill above wrote a change row for every row it hid; raising the floor past them makes every state issued before this migration answer cannotCalculateChanges, so clients resync from scratch and drop what they cached.
UPDATE `jmap_change_floor` SET `seq` = GREATEST(seq, COALESCE((SELECT max(seq) FROM jmap_changes), 0)) WHERE `id` = 1;
