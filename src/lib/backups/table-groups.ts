import type { BackupTableGroupId, DatabaseBackupTable } from "./types";

export const BACKUP_TABLE_GROUPS: { id: BackupTableGroupId; label: string; tables: DatabaseBackupTable[] }[] = [
	{ id: "accounts", label: "Accounts and mailboxes", tables: ["users", "domains", "domain_tracking_hosts", "mailboxes", "mailbox_access", "mailbox_aliases", "contacts", "api_keys", "mcp_key_mailboxes", "sessions", "password_reset_tokens", "mfa_recovery_codes", "login_challenges"] },
	{ id: "mail", label: "Mail and related data", tables: ["folders", "messages", "message_attachments", "shared_attachment_links", "outbound_jobs", "message_tracking", "message_opens", "email_templates", "calendar_events", "booking_events", "auto_reply_deliveries", "spam_token_stats", "spam_reputation", "spam_feedback"] },
	{ id: "automation", label: "Routing and webhooks", tables: ["routing_rules", "webhooks", "webhook_deliveries"] },
	{ id: "assistant", label: "Assistant and AI usage", tables: ["mailbox_agent_settings", "agent_conversations", "agent_chat_messages", "agent_jobs", "agent_draft_metadata", "agent_send_approvals", "ai_usage"] },
	{ id: "drive", label: "Drive uploads and shares", tables: ["drive_items", "drive_upload_parts", "drive_shares"] },
	{ id: "system", label: "App settings and history", tables: ["audit_logs", "backup_settings", "backups", "app_settings", "license_settings"] },
];

export function getSelectedBackupTables(excludedGroups: BackupTableGroupId[]): Set<DatabaseBackupTable> {
	const excluded = new Set(excludedGroups);
	return new Set(BACKUP_TABLE_GROUPS.filter((group) => !excluded.has(group.id)).flatMap((group) => group.tables));
}

export function parseExcludedBackupTableGroups(value: string): BackupTableGroupId[] {
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		const known = new Set(BACKUP_TABLE_GROUPS.map((group) => group.id));
		return parsed.filter((group): group is BackupTableGroupId => typeof group === "string" && known.has(group as BackupTableGroupId));
	} catch {
		return [];
	}
}
