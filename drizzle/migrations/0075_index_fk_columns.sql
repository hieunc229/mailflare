-- Index every unindexed foreign-key column. SQLite does not index the child
-- side of a foreign key, so each DELETE (or parent-key UPDATE) on a parent
-- row scans the whole child table looking for referrers. On tables that
-- grow unboundedly (audit_logs especially) this turns routine deletes —
-- emptying trash, bulk actions — into O(parents x children) work.
CREATE INDEX IF NOT EXISTS `users_created_by_idx` ON `users` (`created_by_user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `mailbox_access_created_by_idx` ON `mailbox_access` (`created_by_user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `api_keys_user_idx` ON `api_keys` (`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `spam_feedback_actor_user_idx` ON `spam_feedback` (`actor_user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `outbound_jobs_user_idx` ON `outbound_jobs` (`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `outbound_jobs_message_idx` ON `outbound_jobs` (`message_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `calendar_events_mailbox_idx` ON `calendar_events` (`mailbox_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `routing_rules_user_idx` ON `routing_rules` (`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `routing_rules_folder_idx` ON `routing_rules` (`folder_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `webhooks_user_idx` ON `webhooks` (`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `push_devices_api_key_idx` ON `push_devices` (`api_key_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `login_challenges_user_idx` ON `login_challenges` (`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_logs_message_id_idx` ON `audit_logs` (`message_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_logs_target_user_idx` ON `audit_logs` (`target_user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `backups_created_by_idx` ON `backups` (`created_by_user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `mailbox_agent_settings_reviewer_idx` ON `mailbox_agent_settings` (`reviewer_user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_conversations_mailbox_idx` ON `agent_conversations` (`mailbox_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_jobs_source_message_idx` ON `agent_jobs` (`source_message_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_jobs_draft_idx` ON `agent_jobs` (`draft_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_jobs_reviewer_idx` ON `agent_jobs` (`reviewer_user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_draft_meta_source_msg_idx` ON `agent_draft_metadata` (`source_message_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_draft_metadata_mailbox_idx` ON `agent_draft_metadata` (`mailbox_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_send_approvals_request_key_idx` ON `agent_send_approvals` (`request_key_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_send_approvals_mailbox_idx` ON `agent_send_approvals` (`mailbox_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `mcp_key_mailboxes_mailbox_idx` ON `mcp_key_mailboxes` (`mailbox_id`);
