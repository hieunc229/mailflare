const MIGRATION_NAMES = [
	"0000_flowery_smasher.sql",
	"0001_add_reset_email.sql",
	"0002_add_message_read.sql",
	"0003_add_contacts.sql",
	"0004_add_accounts.sql",
	"0005_add_folders.sql",
	"0006_add_rule_conditions.sql",
	"0007_add_shared_mailboxes.sql",
	"0008_add_message_attachments.sql",
	"0009_add_backups.sql",
	"0010_hard_squirrel_girl.sql",
	"0011_add_folder_colors.sql",
	"0012_add_app_settings.sql",
	"0013_add_license_settings.sql",
	"0014_add_account_permissions.sql",
	"0015_add_forwarding_email.sql",
	"0016_add_message_snooze.sql",
	"0017_add_message_star.sql",
	"0018_add_mailbox_domain_aliases.sql",
	"0019_merge_message_bodies.sql",
	"0020_add_calendar_templates_schedule.sql",
	"0021_add_mailbox_signature.sql",
	"0022_add_mailbox_auto_reply.sql",
	"0023_add_mailbox_aliases.sql",
	"0024_add_advanced_routing_and_webhook_retries.sql",
	"0025_add_threading_and_cc_bcc.sql",
	"0026_add_contact_avatars.sql",
	"0027_add_domain_sending_intent.sql",
	"0028_add_keyboard_shortcuts_setting.sql",
	"0029_add_spam_protection.sql",
	"0030_add_message_search_index.sql",
	"0031_add_password_reset_and_mfa.sql",
	"0032_add_device_tokens.sql",
];

const INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY NOT NULL, email text NOT NULL UNIQUE, reset_email text, forwarding_email text, password_hash text NOT NULL, name text NOT NULL, avatar_key text, role text DEFAULT 'user' NOT NULL, disabled integer DEFAULT false NOT NULL, can_manage_mailboxes integer DEFAULT false NOT NULL, keyboard_shortcuts_enabled integer DEFAULT true NOT NULL, spam_protection_enabled integer DEFAULT true NOT NULL, totp_secret text, totp_enabled integer DEFAULT false NOT NULL, totp_confirmed_at integer, created_by_user_id text REFERENCES users(id) ON DELETE set null, created_at integer NOT NULL);
CREATE INDEX IF NOT EXISTS users_created_by_idx ON users(created_by_user_id);
CREATE TABLE IF NOT EXISTS domains (id text PRIMARY KEY NOT NULL, user_id text NOT NULL REFERENCES users(id) ON DELETE cascade, hostname text NOT NULL, zone_id text NOT NULL, status text DEFAULT 'pending' NOT NULL, routing_status text, sending_subdomain_tag text, sending_requested integer DEFAULT false NOT NULL, sending_enabled integer DEFAULT false NOT NULL, routing_enabled integer DEFAULT false NOT NULL, created_at integer NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS domains_hostname_idx ON domains(hostname);
CREATE INDEX IF NOT EXISTS domains_user_idx ON domains(user_id);
CREATE TABLE IF NOT EXISTS mailboxes (id text PRIMARY KEY NOT NULL, user_id text NOT NULL REFERENCES users(id) ON DELETE cascade, domain_id text NOT NULL REFERENCES domains(id) ON DELETE cascade, local_part text NOT NULL, display_name text, signature text, auto_reply_enabled integer DEFAULT false NOT NULL, auto_reply_subject text DEFAULT 'Out of office' NOT NULL, auto_reply_body text DEFAULT '' NOT NULL, avatar_key text, type text DEFAULT 'personal' NOT NULL, use_all_domains integer DEFAULT true NOT NULL, disabled integer DEFAULT false NOT NULL, created_at integer NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS mailboxes_address_idx ON mailboxes(domain_id, local_part);
CREATE TABLE IF NOT EXISTS mailbox_aliases (id text PRIMARY KEY NOT NULL, mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE cascade, domain_id text NOT NULL REFERENCES domains(id) ON DELETE cascade, local_part text NOT NULL, created_at integer NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS mailbox_aliases_address_idx ON mailbox_aliases(domain_id, local_part);
CREATE INDEX IF NOT EXISTS mailbox_aliases_mailbox_idx ON mailbox_aliases(mailbox_id);
CREATE TABLE IF NOT EXISTS auto_reply_deliveries (id text PRIMARY KEY NOT NULL, mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE cascade, recipient text NOT NULL, sent_at integer NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS auto_reply_deliveries_mailbox_recipient_idx ON auto_reply_deliveries(mailbox_id, recipient);
CREATE INDEX IF NOT EXISTS auto_reply_deliveries_sent_idx ON auto_reply_deliveries(sent_at);
CREATE TABLE IF NOT EXISTS mailbox_access (id text PRIMARY KEY NOT NULL, mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE cascade, user_id text NOT NULL REFERENCES users(id) ON DELETE cascade, permission text DEFAULT 'read_only' NOT NULL, created_by_user_id text REFERENCES users(id) ON DELETE set null, created_at integer NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS mailbox_access_mailbox_user_idx ON mailbox_access(mailbox_id, user_id);
CREATE INDEX IF NOT EXISTS mailbox_access_user_idx ON mailbox_access(user_id);
CREATE INDEX IF NOT EXISTS mailbox_access_mailbox_idx ON mailbox_access(mailbox_id);
CREATE TABLE IF NOT EXISTS contacts (id text PRIMARY KEY NOT NULL, user_id text NOT NULL REFERENCES users(id) ON DELETE cascade, email text NOT NULL, display_name text, avatar_key text, source text DEFAULT 'inbound' NOT NULL, blocked integer DEFAULT false NOT NULL, last_seen_at integer, created_at integer NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_user_email_idx ON contacts(user_id, email);
CREATE INDEX IF NOT EXISTS contacts_user_idx ON contacts(user_id);
CREATE TABLE IF NOT EXISTS folders (id text PRIMARY KEY NOT NULL, user_id text NOT NULL REFERENCES users(id) ON DELETE cascade, mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE cascade, name text NOT NULL, color text DEFAULT '#2563eb' NOT NULL, created_at integer NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS folders_mailbox_name_idx ON folders(mailbox_id, name);
CREATE INDEX IF NOT EXISTS folders_user_idx ON folders(user_id);
CREATE INDEX IF NOT EXISTS folders_mailbox_idx ON folders(mailbox_id);
CREATE TABLE IF NOT EXISTS api_keys (id text PRIMARY KEY NOT NULL, user_id text NOT NULL REFERENCES users(id) ON DELETE cascade, name text NOT NULL, prefix text NOT NULL, key_hash text NOT NULL, scopes text NOT NULL, created_at integer NOT NULL, last_used_at integer);
CREATE TABLE IF NOT EXISTS messages (id text PRIMARY KEY NOT NULL, user_id text NOT NULL REFERENCES users(id) ON DELETE cascade, mailbox_id text REFERENCES mailboxes(id) ON DELETE set null, direction text NOT NULL, provider_message_id text, folder_id text REFERENCES folders(id) ON DELETE set null, from_addr text NOT NULL, to_addr text NOT NULL, cc_addr text, bcc_addr text, subject text, snippet text, text_body text, html_body text, raw_r2_key text, status text DEFAULT 'received' NOT NULL, read integer DEFAULT false NOT NULL, starred integer DEFAULT false NOT NULL, snoozed_until integer, thread_id text, in_reply_to text, references_header text, spam_score integer, spam_verdict text, spam_signals text, spam_analyzed_at integer, spam_analysis_error text, created_at integer NOT NULL);
CREATE INDEX IF NOT EXISTS messages_user_created_idx ON messages(user_id, created_at);
CREATE INDEX IF NOT EXISTS messages_mailbox_idx ON messages(mailbox_id);
CREATE INDEX IF NOT EXISTS messages_folder_idx ON messages(folder_id);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(subject, from_addr, to_addr, cc_addr, text_body, html_body, content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, subject, from_addr, to_addr, cc_addr, text_body, html_body) VALUES (new.rowid, new.subject, new.from_addr, new.to_addr, new.cc_addr, new.text_body, new.html_body); END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, subject, from_addr, to_addr, cc_addr, text_body, html_body) VALUES ('delete', old.rowid, old.subject, old.from_addr, old.to_addr, old.cc_addr, old.text_body, old.html_body); END;
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF subject, from_addr, to_addr, cc_addr, text_body, html_body ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, subject, from_addr, to_addr, cc_addr, text_body, html_body) VALUES ('delete', old.rowid, old.subject, old.from_addr, old.to_addr, old.cc_addr, old.text_body, old.html_body); INSERT INTO messages_fts(rowid, subject, from_addr, to_addr, cc_addr, text_body, html_body) VALUES (new.rowid, new.subject, new.from_addr, new.to_addr, new.cc_addr, new.text_body, new.html_body); END;
CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages(mailbox_id, thread_id);
CREATE INDEX IF NOT EXISTS messages_provider_message_idx ON messages(mailbox_id, provider_message_id);
CREATE INDEX IF NOT EXISTS messages_raw_r2_key_idx ON messages(raw_r2_key);
CREATE TABLE IF NOT EXISTS spam_token_stats (mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE cascade, token text NOT NULL, spam_count integer DEFAULT 0 NOT NULL, ham_count integer DEFAULT 0 NOT NULL, updated_at integer NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS spam_token_stats_mailbox_token_idx ON spam_token_stats(mailbox_id, token);
CREATE INDEX IF NOT EXISTS spam_token_stats_mailbox_idx ON spam_token_stats(mailbox_id);
CREATE TABLE IF NOT EXISTS spam_reputation (mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE cascade, type text NOT NULL, key text NOT NULL, messages_seen integer DEFAULT 0 NOT NULL, spam_count integer DEFAULT 0 NOT NULL, ham_count integer DEFAULT 0 NOT NULL, first_seen_at integer NOT NULL, last_seen_at integer NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS spam_reputation_mailbox_type_key_idx ON spam_reputation(mailbox_id, type, key);
CREATE INDEX IF NOT EXISTS spam_reputation_mailbox_idx ON spam_reputation(mailbox_id);
CREATE TABLE IF NOT EXISTS spam_feedback (message_id text PRIMARY KEY NOT NULL REFERENCES messages(id) ON DELETE cascade, mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE cascade, actor_user_id text REFERENCES users(id) ON DELETE set null, classification text NOT NULL, training_tokens text NOT NULL, reputation_keys text NOT NULL, tokenizer_version integer DEFAULT 1 NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL);
CREATE INDEX IF NOT EXISTS spam_feedback_mailbox_idx ON spam_feedback(mailbox_id);
CREATE TABLE IF NOT EXISTS message_attachments (id text PRIMARY KEY NOT NULL, message_id text NOT NULL REFERENCES messages(id) ON DELETE cascade, filename text NOT NULL, content_type text NOT NULL, size integer NOT NULL, disposition text DEFAULT 'attachment' NOT NULL, content_id text, r2_key text NOT NULL UNIQUE, created_at integer NOT NULL);
CREATE INDEX IF NOT EXISTS message_attachments_message_idx ON message_attachments(message_id);
CREATE TABLE IF NOT EXISTS outbound_jobs (id text PRIMARY KEY NOT NULL, user_id text NOT NULL REFERENCES users(id) ON DELETE cascade, message_id text REFERENCES messages(id) ON DELETE set null, status text DEFAULT 'queued' NOT NULL, payload text NOT NULL, error text, scheduled_at integer, created_at integer NOT NULL, updated_at integer NOT NULL);
CREATE TABLE IF NOT EXISTS email_templates (id text PRIMARY KEY NOT NULL, user_id text NOT NULL REFERENCES users(id) ON DELETE cascade, name text NOT NULL, subject text DEFAULT '' NOT NULL, text_body text DEFAULT '' NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL);
CREATE INDEX IF NOT EXISTS email_templates_user_idx ON email_templates(user_id);
CREATE TABLE IF NOT EXISTS calendar_events (id text PRIMARY KEY NOT NULL, user_id text NOT NULL REFERENCES users(id) ON DELETE cascade, mailbox_id text REFERENCES mailboxes(id) ON DELETE set null, title text NOT NULL, description text DEFAULT '' NOT NULL, location text DEFAULT '' NOT NULL, attendees text DEFAULT '[]' NOT NULL, starts_at integer NOT NULL, ends_at integer NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL);
CREATE INDEX IF NOT EXISTS calendar_events_user_starts_idx ON calendar_events(user_id, starts_at);
CREATE TABLE IF NOT EXISTS routing_rules (id text PRIMARY KEY NOT NULL, user_id text NOT NULL REFERENCES users(id) ON DELETE cascade, domain_id text NOT NULL REFERENCES domains(id) ON DELETE cascade, scope text DEFAULT 'mailbox' NOT NULL, name text, enabled integer DEFAULT true NOT NULL, pattern text NOT NULL, match_field text DEFAULT 'email' NOT NULL, match_operator text DEFAULT 'contains' NOT NULL, match_value text DEFAULT '' NOT NULL, mailbox_id text REFERENCES mailboxes(id) ON DELETE set null, folder_id text REFERENCES folders(id) ON DELETE set null, action text DEFAULT 'store' NOT NULL, forward_to text, keep_copy integer DEFAULT false NOT NULL, reject_reason text, priority integer DEFAULT 0 NOT NULL, last_matched_at integer, match_count integer DEFAULT 0 NOT NULL, created_at integer NOT NULL);
CREATE INDEX IF NOT EXISTS routing_rules_domain_scope_idx ON routing_rules(domain_id, scope, enabled);
CREATE INDEX IF NOT EXISTS routing_rules_mailbox_idx ON routing_rules(mailbox_id);
CREATE INDEX IF NOT EXISTS routing_rules_priority_idx ON routing_rules(priority);
CREATE TABLE IF NOT EXISTS webhooks (id text PRIMARY KEY NOT NULL, user_id text NOT NULL REFERENCES users(id) ON DELETE cascade, description text, url text NOT NULL, secret text NOT NULL, events text NOT NULL, enabled integer DEFAULT true NOT NULL, max_attempts integer DEFAULT 5 NOT NULL, created_at integer NOT NULL);
CREATE TABLE IF NOT EXISTS webhook_deliveries (id text PRIMARY KEY NOT NULL, webhook_id text NOT NULL REFERENCES webhooks(id) ON DELETE cascade, event_type text NOT NULL, payload text NOT NULL, status text DEFAULT 'pending' NOT NULL, attempts integer DEFAULT 0 NOT NULL, response_status integer, error text, duration_ms integer, last_attempt_at integer, next_retry_at integer, created_at integer NOT NULL);
CREATE INDEX IF NOT EXISTS webhook_deliveries_webhook_idx ON webhook_deliveries(webhook_id, created_at);
CREATE INDEX IF NOT EXISTS webhook_deliveries_status_idx ON webhook_deliveries(status);
CREATE TABLE IF NOT EXISTS password_reset_tokens (id text PRIMARY KEY NOT NULL, user_id text NOT NULL REFERENCES users(id) ON DELETE cascade, token_hash text NOT NULL UNIQUE, expires_at integer NOT NULL, used_at integer, created_at integer NOT NULL);
CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx ON password_reset_tokens(user_id);
CREATE TABLE IF NOT EXISTS mfa_recovery_codes (id text PRIMARY KEY NOT NULL, user_id text NOT NULL REFERENCES users(id) ON DELETE cascade, code_hash text NOT NULL UNIQUE, used_at integer, created_at integer NOT NULL);
CREATE INDEX IF NOT EXISTS mfa_recovery_codes_user_idx ON mfa_recovery_codes(user_id);
CREATE TABLE IF NOT EXISTS login_challenges (id text PRIMARY KEY NOT NULL, user_id text NOT NULL REFERENCES users(id) ON DELETE cascade, token_hash text NOT NULL UNIQUE, expires_at integer NOT NULL, created_at integer NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id text PRIMARY KEY NOT NULL, user_id text NOT NULL REFERENCES users(id) ON DELETE cascade, token_hash text NOT NULL UNIQUE, expires_at integer NOT NULL, created_at integer NOT NULL);
CREATE TABLE IF NOT EXISTS audit_logs (id text PRIMARY KEY NOT NULL, actor_user_id text REFERENCES users(id) ON DELETE set null, target_user_id text REFERENCES users(id) ON DELETE set null, mailbox_id text REFERENCES mailboxes(id) ON DELETE set null, message_id text REFERENCES messages(id) ON DELETE set null, action text NOT NULL, metadata text, created_at integer NOT NULL);
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON audit_logs(actor_user_id);
CREATE INDEX IF NOT EXISTS audit_logs_mailbox_idx ON audit_logs(mailbox_id);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at);
CREATE TABLE IF NOT EXISTS backup_settings (id text PRIMARY KEY NOT NULL, enabled integer DEFAULT false NOT NULL, schedule_type text DEFAULT 'daily' NOT NULL, schedule_value integer, retention_enabled integer DEFAULT false NOT NULL, retention_days integer DEFAULT 30 NOT NULL, updated_at integer NOT NULL);
INSERT OR IGNORE INTO backup_settings (id, enabled, schedule_type, retention_enabled, retention_days, updated_at) VALUES ('default', false, 'daily', false, 30, unixepoch());
CREATE TABLE IF NOT EXISTS backups (id text PRIMARY KEY NOT NULL, status text DEFAULT 'queued' NOT NULL, trigger text NOT NULL, r2_key text, filename text, size integer, error text, created_by_user_id text REFERENCES users(id) ON DELETE set null, created_at integer NOT NULL, started_at integer, completed_at integer);
CREATE INDEX IF NOT EXISTS backups_created_idx ON backups(created_at);
CREATE INDEX IF NOT EXISTS backups_status_idx ON backups(status);
CREATE TABLE IF NOT EXISTS app_settings (id text PRIMARY KEY NOT NULL, app_name text DEFAULT 'Mailflare' NOT NULL, icon_key text, updated_at integer NOT NULL);
INSERT OR IGNORE INTO app_settings (id, app_name, updated_at) VALUES ('default', 'Mailflare', unixepoch());
CREATE TABLE IF NOT EXISTS license_settings (id text PRIMARY KEY NOT NULL, instance_id text NOT NULL, instance_url text, license_key_hash text, plan text DEFAULT 'community' NOT NULL, state text DEFAULT 'inactive' NOT NULL, features text DEFAULT '[]' NOT NULL, activated_at integer, validated_at integer, updated_at integer NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS license_settings_instance_id_unique ON license_settings(instance_id);
CREATE TABLE IF NOT EXISTS device_tokens (id text PRIMARY KEY NOT NULL, user_id text NOT NULL REFERENCES users(id) ON DELETE cascade, token text NOT NULL, platform text NOT NULL, created_at integer NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS device_tokens_user_token_idx ON device_tokens(user_id, token);
CREATE INDEX IF NOT EXISTS device_tokens_user_idx ON device_tokens(user_id);
CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
`;

export async function migrateCleanDatabase(db: D1Database): Promise<boolean> {
	const existing = await db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT IN ('d1_migrations', 'd1_kv')")
		.all<{ name: string }>();
	if (existing.results.length > 0) {
		const tableNames = new Set(existing.results.map((table) => table.name));
		if (tableNames.has("users") && tableNames.has("domains")) return false;
		throw new Error(
			"The D1 database is not empty, but the Mailflare schema is incomplete. Apply the committed D1 migrations before continuing setup.",
		);
	}

	const schemaStatements = splitSqlStatements(INITIAL_SCHEMA_SQL).map((statement) => db.prepare(statement));
	const migrationStatements = MIGRATION_NAMES.map((name) =>
		db.prepare("INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)").bind(name),
	);
	await db.batch([...schemaStatements, ...migrationStatements]);
	return true;
}

/**
 * Split the bootstrap SQL into statements. A plain split on ";" would cut a
 * trigger body apart, so pieces are joined back together until every BEGIN
 * has its END.
 */
export function splitSqlStatements(sqlText: string): string[] {
	const statements: string[] = [];
	let current = "";
	for (const piece of sqlText.split(";")) {
		current = current ? `${current};${piece}` : piece;
		const opened = (current.match(/\bBEGIN\b/gi) ?? []).length;
		const closed = (current.match(/\bEND\b/gi) ?? []).length;
		if (opened > closed) continue;
		const statement = current.trim();
		if (statement) statements.push(statement);
		current = "";
	}
	const rest = current.trim();
	if (rest) statements.push(rest);
	return statements;
}
