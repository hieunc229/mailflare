DROP INDEX IF EXISTS "mailbox_access_mailbox_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "contacts_user_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "folders_mailbox_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "spam_token_stats_mailbox_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "spam_reputation_mailbox_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "calendar_event_overrides_event_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "calendar_occurrence_responses_event_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "booking_events_user_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "auto_reply_deliveries_sent_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "webhook_deliveries_status_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "routing_rules_priority_idx";
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "remote_content_mode" SET DEFAULT 'ask';
--> statement-breakpoint
DROP TRIGGER messages_jmap_changed ON messages;
--> statement-breakpoint
CREATE TRIGGER messages_jmap_changed AFTER INSERT OR UPDATE OF mailbox_id, folder_id, status, read, starred, category, direction, thread_id, provider_message_id, in_reply_to, references_header, from_addr, to_addr, cc_addr, bcc_addr, reply_to, subject, snippet, text_body, html_body, created_at, snoozed_until, private_draft OR DELETE ON messages
FOR EACH ROW EXECUTE FUNCTION mailflare_messages_changed();
