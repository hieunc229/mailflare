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
