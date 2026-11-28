-- `action` is longtext on every install, and MySQL indexes longtext only by prefix. Changing its type would copy the whole audit table and block writes (logins) meanwhile.
CREATE INDEX `audit_logs_target_action_created_idx` ON `audit_logs` (`target_user_id`,`action`(64),`created_at`);
--> statement-breakpoint
DROP INDEX `mailbox_access_mailbox_idx` ON `mailbox_access`;
--> statement-breakpoint
DROP INDEX `contacts_user_idx` ON `contacts`;
--> statement-breakpoint
DROP INDEX `folders_mailbox_idx` ON `folders`;
--> statement-breakpoint
DROP INDEX `spam_token_stats_mailbox_idx` ON `spam_token_stats`;
--> statement-breakpoint
DROP INDEX `spam_reputation_mailbox_idx` ON `spam_reputation`;
--> statement-breakpoint
DROP INDEX `calendar_event_overrides_event_idx` ON `calendar_event_overrides`;
--> statement-breakpoint
DROP INDEX `calendar_occurrence_responses_event_idx` ON `calendar_occurrence_responses`;
--> statement-breakpoint
DROP INDEX `booking_events_user_idx` ON `booking_events`;
--> statement-breakpoint
DROP INDEX `auto_reply_deliveries_sent_idx` ON `auto_reply_deliveries`;
--> statement-breakpoint
DROP INDEX `webhook_deliveries_status_idx` ON `webhook_deliveries`;
--> statement-breakpoint
DROP INDEX `routing_rules_priority_idx` ON `routing_rules`;
--> statement-breakpoint
DROP INDEX `audit_logs_target_user_idx` ON `audit_logs`;
--> statement-breakpoint
DROP INDEX `messages_thread_key_idx` ON `messages`;
--> statement-breakpoint
DROP INDEX `messages_mailbox_thread_key_idx` ON `messages`;
--> statement-breakpoint
ALTER TABLE `users` ALTER COLUMN `remote_content_mode` SET DEFAULT 'ask';
--> statement-breakpoint
ALTER TABLE `mailbox_promotion_settings` MODIFY `backfill_scanned` bigint NOT NULL DEFAULT 0, MODIFY `backfill_stalls` bigint NOT NULL DEFAULT 0, MODIFY `backfill_day` bigint NOT NULL DEFAULT 0, MODIFY `backfill_day_rows` bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
-- The new trigger exists before the old one goes, so no update is ever left unlogged.
CREATE TRIGGER messages_jmap_au_v2 AFTER UPDATE ON messages FOR EACH ROW
BEGIN
	IF NOT (OLD.mailbox_id <=> NEW.mailbox_id AND OLD.folder_id <=> NEW.folder_id AND OLD.status <=> NEW.status AND OLD.`read` <=> NEW.`read` AND OLD.starred <=> NEW.starred AND OLD.category <=> NEW.category AND OLD.direction <=> NEW.direction AND OLD.thread_id <=> NEW.thread_id AND OLD.provider_message_id <=> NEW.provider_message_id AND OLD.in_reply_to <=> NEW.in_reply_to AND OLD.references_header <=> NEW.references_header AND OLD.from_addr <=> NEW.from_addr AND OLD.to_addr <=> NEW.to_addr AND OLD.cc_addr <=> NEW.cc_addr AND OLD.bcc_addr <=> NEW.bcc_addr AND OLD.reply_to <=> NEW.reply_to AND OLD.subject <=> NEW.subject AND OLD.snippet <=> NEW.snippet AND OLD.text_body <=> NEW.text_body AND OLD.html_body <=> NEW.html_body AND OLD.created_at <=> NEW.created_at AND OLD.snoozed_until <=> NEW.snoozed_until AND OLD.private_draft <=> NEW.private_draft) THEN
		IF NEW.mailbox_id IS NOT NULL THEN
			INSERT INTO jmap_mailbox_revisions (mailbox_id, revision) VALUES (NEW.mailbox_id, 1) ON DUPLICATE KEY UPDATE revision = revision + 1;
		END IF;
		IF OLD.mailbox_id IS NOT NULL AND NOT (OLD.mailbox_id <=> NEW.mailbox_id) THEN
			INSERT INTO jmap_mailbox_revisions (mailbox_id, revision) VALUES (OLD.mailbox_id, 1) ON DUPLICATE KEY UPDATE revision = revision + 1;
		END IF;
		IF OLD.mailbox_id <=> NEW.mailbox_id THEN
			IF NEW.mailbox_id IS NOT NULL THEN
				INSERT INTO jmap_changes (mailbox_id, object_type, object_id, thread_id, `change`)
				VALUES (NEW.mailbox_id, 'email', NEW.id, coalesce(NEW.thread_id, NEW.id), 'updated');
			END IF;
		ELSE
			IF OLD.mailbox_id IS NOT NULL THEN
				INSERT INTO jmap_changes (mailbox_id, object_type, object_id, thread_id, `change`)
				VALUES (OLD.mailbox_id, 'email', OLD.id, coalesce(OLD.thread_id, OLD.id), 'destroyed');
			END IF;
			IF NEW.mailbox_id IS NOT NULL THEN
				INSERT INTO jmap_changes (mailbox_id, object_type, object_id, thread_id, `change`)
				VALUES (NEW.mailbox_id, 'email', NEW.id, coalesce(NEW.thread_id, NEW.id), 'created');
			END IF;
		END IF;
	END IF;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_jmap_au;
