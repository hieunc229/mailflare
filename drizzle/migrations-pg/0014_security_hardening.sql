-- Security hardening: messages.private_draft (unsent drafts stay private to their author wherever they are moved) and users.totp_last_step.
ALTER TABLE "messages" ADD COLUMN "private_draft" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Existing rows: every draft, plus outbound mail in Trash, Archive or the inbox that was never submitted for sending (a draft its author moved).
-- Nothing recorded the move, so this errs towards hiding.
UPDATE "messages" SET "private_draft" = true
WHERE "status" = 'draft'
	OR ("direction" = 'outbound'
		AND "status" IN ('trash', 'received', 'archived')
		AND NOT EXISTS (SELECT 1 FROM "outbound_jobs" WHERE "outbound_jobs"."message_id" = "messages"."id"));
--> statement-breakpoint
-- The draft filter (user_id = ? OR NOT private_draft) is part of the counts and navigation queries, so both covering indexes gain the two columns (last, so the GROUP BY and ORDER BY prefixes are unchanged).
DROP INDEX IF EXISTS "messages_nav_cover_idx";
--> statement-breakpoint
CREATE INDEX "messages_nav_cover_idx" ON "messages" USING btree ("mailbox_id","status","folder_id","created_at" desc,"id" desc,"direction","read","thread_id","snoozed_until","user_id","private_draft");
--> statement-breakpoint
DROP INDEX IF EXISTS "messages_counts_cover_idx";
--> statement-breakpoint
CREATE INDEX "messages_counts_cover_idx" ON "messages" USING btree ("mailbox_id","folder_id","direction","status","read","starred","snoozed_until","user_id","private_draft");
--> statement-breakpoint
-- users.totp_last_step: the last accepted TOTP time step, so a code cannot be used twice within its window.
ALTER TABLE "users" ADD COLUMN "totp_last_step" bigint;
--> statement-breakpoint
-- JMAP clients may hold other users' drafts in their cache. The backfill above wrote a change row for every row it hid; raising the floor past them makes every state issued before this migration answer cannotCalculateChanges, so clients resync from scratch and drop what they cached.
UPDATE "jmap_change_floor" SET "seq" = GREATEST(seq, COALESCE((SELECT max(seq) FROM jmap_changes), 0)) WHERE "id" = 1;
