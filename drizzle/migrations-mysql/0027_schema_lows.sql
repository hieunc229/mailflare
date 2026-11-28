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
