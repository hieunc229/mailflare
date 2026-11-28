CREATE INDEX `audit_logs_target_action_created_idx` ON `audit_logs` (`target_user_id`,`action`,`created_at`);
--> statement-breakpoint
DROP INDEX IF EXISTS `mailbox_access_mailbox_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `contacts_user_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `folders_mailbox_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `spam_token_stats_mailbox_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `spam_reputation_mailbox_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `calendar_event_overrides_event_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `calendar_occurrence_responses_event_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `booking_events_user_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `auto_reply_deliveries_sent_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `webhook_deliveries_status_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `routing_rules_priority_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `audit_logs_target_user_idx`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `jmap_changes_messages_au`;
--> statement-breakpoint
CREATE TRIGGER `jmap_changes_messages_au` AFTER UPDATE OF mailbox_id, folder_id, status, read, starred, category, direction, thread_id, provider_message_id, in_reply_to, references_header, from_addr, to_addr, cc_addr, bcc_addr, reply_to, subject, snippet, text_body, html_body, created_at, snoozed_until, private_draft ON `messages`
WHEN NEW.mailbox_id IS NOT NULL AND OLD.mailbox_id IS NEW.mailbox_id BEGIN
	INSERT INTO jmap_changes (mailbox_id, object_type, object_id, thread_id, change)
	VALUES (NEW.mailbox_id, 'email', NEW.id, coalesce(NEW.thread_id, NEW.id), 'updated');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `jmap_messages_au`;
--> statement-breakpoint
CREATE TRIGGER `jmap_messages_au` AFTER UPDATE OF mailbox_id, folder_id, status, read, starred, category, direction, thread_id, provider_message_id, in_reply_to, references_header, from_addr, to_addr, cc_addr, bcc_addr, reply_to, subject, snippet, text_body, html_body, created_at, snoozed_until, private_draft ON `messages`
WHEN NEW.mailbox_id IS NOT NULL BEGIN
	INSERT INTO jmap_mailbox_revisions (mailbox_id, revision) VALUES (NEW.mailbox_id, 1)
	ON CONFLICT(mailbox_id) DO UPDATE SET revision = revision + 1;
END;
