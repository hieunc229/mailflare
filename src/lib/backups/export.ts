import { dialectOf, listColumnNames, listTableNames, quoteIdentifier } from "@/db/introspect";
import type { DatabaseDialect } from "@/db/dialect";
import { isSyncCursorFormat } from "@/lib/external-accounts/cursor";
import { hasControlCharacter, isStoredExternalAccountHost, MAX_IDENTITY_LENGTH } from "@/lib/external-accounts/host";
import { hasUnpairedSurrogate } from "@/lib/external-accounts/text";
import { isSealedSecretFormat } from "@/lib/external-accounts/crypto";
import type { BackupTableGroupId, DatabaseBackupDocument, DatabaseBackupTable, DatabaseRecord } from "./types";
import { mergeLegacyMessageBodies } from "./utils";
import { BACKUP_TABLE_GROUPS, getSelectedBackupTables } from "./table-groups";

/**
 * A restore refusal whose message is safe to show the primary admin: it names a table, a column or a migration,
 * never a row value. The restore route returns this text and hides everything else, because a driver error on
 * an insert repeats the statement with its bound parameters — which for `external_accounts` means ciphertext.
 */
export class BackupRestoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BackupRestoreError";
	}
}

export const BACKUP_TABLES: DatabaseBackupTable[] = ["users", "user_compose_preferences", "domains", "domain_tracking_hosts", "email_suppressions", "domain_deliverability", "mailboxes", "mailbox_access", "contacts", "contact_details", "dav_collections", "dav_cards", "folders", "mailbox_promotion_settings", "mailbox_sender_preferences", "api_keys", "messages", "message_attachments", "shared_attachment_links", "outbound_jobs", "message_tracking", "message_opens", "follow_ups", "conversation_notes", "routing_rules", "webhooks", "webhook_deliveries", "sessions", "audit_logs", "backup_settings", "backups", "app_settings", "deliverability_reports", "dmarc_daily_stats", "tls_daily_stats", "deliverability_alerts", "license_settings", "email_templates", "calendar_events", "dav_calendar_objects", "calendar_event_overrides", "calendar_occurrence_responses", "calendar_invite_tombstones", "booking_events", "booking_confirmation_templates", "auto_reply_deliveries", "spam_token_stats", "spam_reputation", "spam_feedback", "mailbox_aliases", "password_reset_tokens", "mfa_recovery_codes", "login_challenges", "passkey_credentials", "mailbox_agent_settings", "agent_conversations", "agent_chat_messages", "agent_jobs", "agent_draft_metadata", "agent_send_approvals", "mcp_key_mailboxes", "ai_usage", "drive_items", "drive_upload_parts", "drive_shares", "external_accounts"];
/**
 * Tables every backup document must contain. Tables added to BACKUP_TABLES
 * after the format shipped are absent from older documents, so they stay
 * optional here and are filled in as empty on restore.
 */
/** Added by migrations 0068 and later; databases that have not applied them yet back up and restore without them. */
const LATER_MIGRATION_TABLES: DatabaseBackupTable[] = ["domain_tracking_hosts", "message_tracking", "message_opens", "follow_ups", "conversation_notes", "user_compose_preferences", "booking_confirmation_templates", "mailbox_promotion_settings", "mailbox_sender_preferences", "dav_collections", "dav_cards", "dav_calendar_objects", "email_suppressions", "domain_deliverability", "deliverability_reports", "dmarc_daily_stats", "deliverability_alerts", "tls_daily_stats", "contact_details", "external_accounts"];
const REQUIRED_BACKUP_TABLES: DatabaseBackupTable[] = ["users", "domains", "mailboxes", "mailbox_access", "contacts", "folders", "mailbox_promotion_settings", "mailbox_sender_preferences", "api_keys", "messages", "message_attachments", "outbound_jobs", "routing_rules", "webhooks", "webhook_deliveries", "sessions", "audit_logs", "backup_settings", "backups", "app_settings", "license_settings"];
const INSERT_BATCH_SIZE = 50;
/**
 * Serial ids that are never backed up or restored: on PostgreSQL an explicit id does not advance the sequence,
 * so the next insert after a restore would collide. The row's identity is its unique key, not the id.
 */
const OMITTED_COLUMNS: Partial<Record<DatabaseBackupTable, string[]>> = { dmarc_daily_stats: ["id"], tls_daily_stats: ["id"] };

export function getBackupConfigurationStatus(_env?: CloudflareEnv) {
	return { configured: true, missing: [] };
}

/**
 * Tables D1 manages itself, which are intentionally absent from BACKUP_TABLES.
 */
export const INTERNAL_TABLE_PATTERNS = ["sqlite_%", "_cf%", "messages_fts%"];
const matchesPattern = (name: string, pattern: string) => name.startsWith(pattern.replace(/%$/, ""));
/**
 * The search index is derived data: its triggers repopulate it as messages are
 * restored, so it is neither exported nor part of the coverage check.
 */
export const INTERNAL_TABLES = [
	"d1_migrations",
	// The migration ledger of PostgreSQL and MySQL databases.
	"mailflare_migrations",
	// JMAP state counters, also derived: the jmap_messages_* triggers on
	// `messages` insert and bump a row per mailbox as messages are restored.
	// Exporting it would make restore fail, since the triggers recreate these
	// primary keys before the table's own rows would be inserted.
	"jmap_mailbox_revisions",
	// The JMAP change log is derived the same way (jmap_changes_* triggers);
	// after a restore clients resync because their states no longer apply.
	"jmap_changes",
	"jmap_change_floor",
	// The CalDAV/CardDAV change log is derived the same way (dav_changes_* triggers fire as calendar events and
	// cards are restored). dav_sync_state is left out on purpose: a restore into a fresh database then gets a new
	// random epoch, so sync tokens issued by another database are refused instead of trusted.
	"dav_changes",
	"dav_sync_state",
	// Push registrations are re-sent by each app on launch.
	"push_devices",
	// Web-push subscriptions are saved again by each client whenever it resolves
	// its push state, and they reference sessions whose rows a restore replaces.
	"push_subscriptions",
	// Rate limit counters the Vercel runtime creates for itself; they expire within minutes.
	"vercel_rate_limits",
	// Import jobs are transient progress records tied to staged objects that a backup does not carry.
	"import_jobs",
	// WebAuthn ceremonies, step-up grants and enrolment links are short-lived,
	// single-use bearer secrets. Restoring a stale one would be useless at best
	// and dangerous at worst, so backups deliberately omit them.
	"webauthn_challenges",
	"passkey_enrollment_grants",
	"auth_step_ups",
	// Single-use undo-token consumption records. Restoring a stale claim would
	// let an already-used undo token be replayed, and the table is rewritten by
	// the installation that owns the tokens.
	"message_action_undo_claims",
];

/**
 * Groups a document of this format version was expected to cover. Format 1
 * writers could not have known the drive group, so restoring one only
 * requires the groups that existed when it was written.
 */
function groupsForDocumentVersion(version: DatabaseBackupDocument["version"]): typeof BACKUP_TABLE_GROUPS {
	return version === 2 ? BACKUP_TABLE_GROUPS : BACKUP_TABLE_GROUPS.filter((group) => group.id !== "drive");
}

/**
 * Fails the backup when the database contains a table BACKUP_TABLES does not
 * list. Without this, a migration that adds a table silently produces backups
 * that omit it, and the omission only surfaces during a restore.
 */
export async function assertBackupTablesCoverDatabase(db: D1Database): Promise<Set<string>> {
	const names = [...(await listTableNames(db))].filter((name) => !INTERNAL_TABLE_PATTERNS.some((pattern) => matchesPattern(name, pattern)) && !INTERNAL_TABLES.includes(name));
	const covered = new Set<string>(BACKUP_TABLES);
	const unlisted = names.filter((name) => !covered.has(name));
	if (unlisted.length) throw new Error(`Backup aborted: ${unlisted.join(", ")} not listed in BACKUP_TABLES. Add new tables to src/lib/backups/export.ts and assign each to a group in table-groups.ts.`);
	const assigned = BACKUP_TABLE_GROUPS.flatMap((group) => group.tables);
	const ungrouped = BACKUP_TABLES.filter((table) => assigned.filter((item) => item === table).length !== 1);
	const unknown = assigned.filter((table) => !covered.has(table));
	if (ungrouped.length || unknown.length) throw new Error(`Backup aborted: table groups are out of sync (${[...ungrouped, ...unknown].join(", ")}). Update src/lib/backups/table-groups.ts.`);
	return new Set(names);
}

export async function exportDatabaseRecords(db: D1Database, excludedGroups: BackupTableGroupId[] = []): Promise<Uint8Array> {
	const dialect = dialectOf(db);
	const databaseTables = await assertBackupTablesCoverDatabase(db);
	const selected = getSelectedBackupTables(excludedGroups);
	const includedTables = BACKUP_TABLES.filter((table) => selected.has(table));
	if (!includedTables.length) throw new Error("Select at least one backup table group");
	const tables: DatabaseBackupDocument["tables"] = {};
	for (const table of includedTables) {
		if ((table === "shared_attachment_links" || table === "booking_events" || table === "passkey_credentials" || table.startsWith("drive_") || LATER_MIGRATION_TABLES.includes(table)) && !databaseTables.has(table)) {
			tables[table] = [];
			continue;
		}
		const result = await db.prepare(`SELECT * FROM ${table}`).all<DatabaseRecord>();
		// Backups hold SQLite-style values whichever database wrote them, so they restore anywhere.
		const rows = dialect === "sqlite" ? result.results : result.results.map(toPortableRecord);
		const omitted = OMITTED_COLUMNS[table];
		tables[table] = omitted ? rows.map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => !omitted.includes(column)))) : rows;
	}
	const document: DatabaseBackupDocument = { format: "mailflare-database-backup", version: 2, createdAt: new Date().toISOString(), includedTables, tables };
	return new TextEncoder().encode(JSON.stringify(document));
}

/**
 * The destructive part of a restore runs in a transaction on a database that can hold one, and in nothing at
 * all on a database that cannot.
 *
 * `transaction` hands the callback a view bound to one checked-out connection; everything outside that view
 * keeps using the pool (PostgreSQL, MySQL) or waits for the connection (the self-hosted SQLite runtime), so an
 * unrelated request can neither read the uncommitted rows nor have its own write rolled back with the restore.
 * A Cloudflare D1 binding has no interactive transaction, and neither has a driver that talks over HTTP, so a
 * failure there can leave the data partially replaced — `restoreFailure` says so instead of pretending.
 */
type TransactionCapableDatabase = D1Database & {
	transaction?: <T>(work: (tx: D1Database) => Promise<T>) => Promise<T>;
	supportsTransaction?: () => boolean;
};

/** Whether a failure can be rolled back, so the caller knows what a failed restore left behind. */
export function restoreRollsBack(db: D1Database): boolean {
	const candidate = db as TransactionCapableDatabase;
	if (typeof candidate.supportsTransaction === "function") return candidate.supportsTransaction();
	return typeof candidate.transaction === "function";
}

const PARTIAL_RESTORE_MESSAGE =
	"The restore failed and this database cannot roll it back, so some data may already have been replaced. Restore the same backup again (or a snapshot) before using this installation.";

export async function restoreDatabaseRecords(db: D1Database, content: ArrayBuffer): Promise<void> {
	const document = parseDatabaseBackup(content);
	// Format 1 predates the drive group, so its writers could not have named its
	// tables in includedTables; only format 2 documents must cover every group.
	if (document.includedTables && !groupsForDocumentVersion(document.version).every((group) => group.tables.some((table) => document.includedTables?.includes(table)))) throw new BackupRestoreError("This backup contains selected table groups only. Restore requires a backup that includes every table group.");
	mergeLegacyMessageBodies(document);
	fillMissingBackupTables(document);
	const dialect = dialectOf(db);
	const existing = await listTableNames(db);
	const sharedLinksTable = existing.has("shared_attachment_links");
	if (!sharedLinksTable && document.tables.shared_attachment_links?.length) throw new BackupRestoreError("Apply pending database migrations before restoring shared attachment links.");
	const bookingTable = existing.has("booking_events");
	if (!bookingTable && document.tables.booking_events?.length) throw new BackupRestoreError("Apply pending database migrations before restoring booking events.");
	const passkeyTable = existing.has("passkey_credentials");
	if (!passkeyTable && document.tables.passkey_credentials?.length) throw new BackupRestoreError("Apply pending database migrations before restoring passkeys.");
	// Drive migrations ship later than the backup format, so an installation can have a database without them yet.
	const driveTableNames = ["drive_items", "drive_upload_parts", "drive_shares"].filter((table) => existing.has(table));
	if (["drive_items", "drive_upload_parts", "drive_shares"].some((table) => document.tables[table]?.length) && driveTableNames.length !== 3) throw new BackupRestoreError("Apply pending database migrations before restoring the Drive tables.");
	const laterTableNames = LATER_MIGRATION_TABLES.filter((table) => existing.has(table));
	const unmigrated = LATER_MIGRATION_TABLES.filter((table) => document.tables[table]?.length && !laterTableNames.includes(table));
	if (unmigrated.length) throw new BackupRestoreError(`Apply pending database migrations before restoring ${unmigrated.join(", ")}.`);
	const restoreTables = BACKUP_TABLES.filter((table) => (table !== "shared_attachment_links" || sharedLinksTable) && (table !== "booking_events" || bookingTable) && (table !== "passkey_credentials" || passkeyTable) && (!table.startsWith("drive_") || driveTableNames.includes(table)) && (!LATER_MIGRATION_TABLES.includes(table) || laterTableNames.includes(table)));
	const userColumns = await listColumnNames(db, "users");
	const bookingColumns = bookingTable ? await listColumnNames(db, "booking_events") : null;
	// The passkey table can predate later credential columns (aaguid); filter
	// those out instead of failing after the restore has already torn down data.
	const passkeyColumns = passkeyTable ? await listColumnNames(db, "passkey_credentials") : null;
	// Likewise `messages.category` and `sender_address` (derived, so dropping them loses nothing) before their migration.
	const messageColumns = await listColumnNames(db, "messages");
	// The backfill state columns of `mailbox_promotion_settings` (stall count, error, daily counter) arrive with a later migration than the table; they are job bookkeeping, so dropping them restarts nothing that matters.
	const promotionSettingColumns = restoreTables.includes("mailbox_promotion_settings") ? await listColumnNames(db, "mailbox_promotion_settings") : null;
	// These tables gained columns after they shipped (MTA-STS settings, the report kind); a backup from a newer
	// database drops them here instead of failing after the teardown.
	const deliverabilityColumns = new Map<string, Set<string>>();
	for (const table of ["domain_deliverability", "deliverability_reports"]) if (existing.has(table)) deliverabilityColumns.set(table, await listColumnNames(db, table));
	// Every check that can be made without writing happens here, before the first DELETE. The row shape is
	// validated against this database's own columns, so a document carrying a column the table does not have is
	// refused now instead of failing the INSERT after the live rows are gone.
	validateDatabaseBackup(document, restoreTables.includes("external_accounts") ? await listColumnNames(db, "external_accounts") : null, dialect);
	const atomic = restoreRollsBack(db);
	const apply = async (tx: D1Database) => {
		// Mark users deleted before removing them: the passkey trigger permits the
		// cascade to remove the last credential only for an account that is being
		// purged. Deleting users first also empties the table the restore inserts
		// into last, so the rest of the teardown has no live accounts to protect.
		await tx.prepare("UPDATE users SET deleted_at = ?").bind(Math.floor(Date.now() / 1000)).run();
		await tx.prepare("DELETE FROM users").run();
		for (const table of [...restoreTables].reverse()) {
			if (table === "users") continue;
			await tx.prepare(`DELETE FROM ${table}`).run();
		}
		// Derived DAV state of the old data: the triggers rebuild the log as rows are restored, and a new epoch makes every
		// client resync. Explicit because MySQL does not fire triggers for FK cascades, so the teardown above leaves stale rows there.
		for (const table of ["dav_changes", "dav_sync_state"]) if (existing.has(table)) await tx.prepare(`DELETE FROM ${table}`).run();
		// MySQL checks foreign keys per statement; suspend them for the whole insert phase. The setting belongs to
		// the session, not the transaction, so it is put back in a `finally` even when the restore fails — and if
		// that put-back fails the connection is thrown away instead of returning to the pool with checks off.
		const suspendsForeignKeys = dialect === "mysql";
		if (suspendsForeignKeys) await tx.prepare("SET FOREIGN_KEY_CHECKS = 0").run();
		try {
			for (const table of restoreTables) {
				const rows = document.tables[table] ?? [];
				for (let index = 0; index < rows.length; index += INSERT_BATCH_SIZE) {
					const columns = table === "users"
						? userColumns
						: table === "booking_events"
							? bookingColumns
							: table === "passkey_credentials"
								? passkeyColumns
								: table === "messages"
									? messageColumns
									: table === "mailbox_promotion_settings"
										? promotionSettingColumns
										: deliverabilityColumns.get(table) ?? null;
					const statements = rows.slice(index, index + INSERT_BATCH_SIZE).map((row) => createInsertStatement(tx, dialect, table, row, columns));
					if (statements.length > 0) await tx.batch(statements);
				}
			}
		} finally {
			if (suspendsForeignKeys) {
				try {
					await tx.prepare("SET FOREIGN_KEY_CHECKS = 1").run();
				} catch {
					// The connection cannot be trusted to be back to its defaults: throw it away rather than let the
					// pool hand it out with foreign key checks off.
					await (tx as { discard?: () => Promise<void> }).discard?.();
					throw new BackupRestoreError("The restore was rolled back because its database connection could not be reset. Run it again.");
				}
			}
		}
	};

	try {
		if (atomic) await (db as TransactionCapableDatabase).transaction!((tx) => apply(tx));
		else await apply(db);
	} catch (error) {
		// A refusal we wrote ourselves means nothing was written; any other failure on a database that cannot roll
		// back leaves the installation in an unknown state, and the admin has to know that.
		if (!atomic && !(error instanceof BackupRestoreError)) throw new BackupRestoreError(PARTIAL_RESTORE_MESSAGE);
		throw error;
	}
}

function parseDatabaseBackup(content: ArrayBuffer): DatabaseBackupDocument {
	let value: unknown;
	try { value = JSON.parse(new TextDecoder().decode(content)); } catch { throw new BackupRestoreError("The selected file is not a valid Mailflare backup"); }
	if (!isDatabaseBackupDocument(value)) throw new BackupRestoreError("The selected file is not a valid Mailflare backup");
	return value;
}

function isDatabaseBackupDocument(value: unknown): value is DatabaseBackupDocument {
	if (!value || typeof value !== "object") return false;
	const document = value as Partial<DatabaseBackupDocument>;
	if (document.format !== "mailflare-database-backup" || typeof document.version !== "number" || ![1, 2].includes(document.version) || !document.tables) return false;
	if (document.includedTables) {
		if (!Array.isArray(document.includedTables) || !document.includedTables.length || new Set(document.includedTables).size !== document.includedTables.length) return false;
		if (!document.includedTables.every((table) => BACKUP_TABLES.includes(table) && Array.isArray(document.tables?.[table]))) return false;
	} else if (!REQUIRED_BACKUP_TABLES.every((table) => Array.isArray(document.tables?.[table]))) return false;
	return BACKUP_TABLES.every((table) => {
		const rows = document.tables?.[table];
		return rows === undefined || Array.isArray(rows);
	});
}

function createInsertStatement(db: D1Database, dialect: DatabaseDialect, table: DatabaseBackupTable, row: DatabaseRecord, availableColumns: Set<string> | null = null) {
	const omitted = OMITTED_COLUMNS[table] ?? [];
	const columns = Object.keys(row).filter((column) => !omitted.includes(column) && (!availableColumns || availableColumns.has(column)));
	if (columns.length === 0) throw new BackupRestoreError(`Backup contains an invalid ${table} record`);
	const placeholders = columns.map(() => "?").join(", ");
	const identifiers = columns.map((column) => quoteIdentifier(dialect, column)).join(", ");
	return db.prepare(`INSERT INTO ${table} (${identifiers}) VALUES (${placeholders})`).bind(...columns.map((column) => row[column]));
}

/** Backups written before a table joined BACKUP_TABLES simply omit it. */
function fillMissingBackupTables(document: DatabaseBackupDocument): void {
	for (const table of BACKUP_TABLES) {
		if (!document.tables[table]) document.tables[table] = [];
	}
	for (const row of document.tables.booking_events ?? []) {
		if (row.slug === undefined && typeof row.id === "string") row.slug = Array.from(new TextEncoder().encode(row.id)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
	}
	// `private_draft` was added after drafts existed. A backup from before that column restores with
	// the default false unless it is derived the way migration 0090 backfills it, which would publish
	// every draft to the mailbox's other readers: drafts, plus outbound mail in Trash, Archive or the
	// inbox that no outbound job ever sent.
	const submitted = new Set((document.tables.outbound_jobs ?? []).map((job) => job.message_id));
	for (const row of document.tables.messages ?? []) {
		if (row.private_draft !== undefined) continue;
		row.private_draft = row.status === "draft" || (row.direction === "outbound" && ["trash", "received", "archived"].includes(String(row.status)) && !submitted.has(row.id)) ? 1 : 0;
	}
	// `require_second_factor` was added after TOTP already existed. A backup from
	// before that column restores with the default false unless it is derived,
	// which would silently turn MFA off for a TOTP-protected user.
	for (const row of document.tables.users ?? []) {
		if (row.require_second_factor === undefined) {
			row.require_second_factor = Number(row.totp_enabled) === 1 ? 1 : 0;
		}
		// The passkey triggers recount credentials as the table is restored.
		// Resetting avoids counting the exported value twice.
		row.passkey_count = 0;
	}
}

function validateDatabaseBackup(document: DatabaseBackupDocument, externalAccountColumns: Set<string> | null, dialect: DatabaseDialect): void {
	for (const table of BACKUP_TABLES) {
		for (const row of document.tables[table] ?? []) {
			if (!row || typeof row !== "object" || Array.isArray(row)) {
				throw new BackupRestoreError(`Backup contains an invalid ${table} record`);
			}
		}
	}
	validateExternalAccountRows(document, externalAccountColumns, dialect);
}

const isIntegerInRange = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
/**
 * How the destination compares the account identity, so the in-document duplicate check sees what its unique
 * index would see.
 *
 * - SQLite, PostgreSQL and D1 compare text byte for byte: exact values.
 * - MySQL `id` and `mailbox_id` inherit the table's default `utf8mb4_0900_ai_ci`: case-insensitive (and
 *   accent-insensitive, which is not emulated — an accent-only collision is left to the index and the rollback)
 *   and NO PAD, so a trailing space still differs.
 * - MySQL `host` and `username` are `utf8mb4_bin`: case-sensitive but PAD SPACE, so trailing ASCII spaces are
 *   ignored. A trailing NBSP is not padding and stays significant.
 */
function identityComparator(dialect: DatabaseDialect) {
	if (dialect !== "mysql") {
		return {
			id: (id: string) => id,
			identity: (mailboxId: string, host: string, username: string) => JSON.stringify([mailboxId, host, username]),
		};
	}
	// Only the ASCII space pads a utf8mb4_bin value; `trimEnd()` would also swallow NBSP, which the server keeps.
	const stripAsciiPadding = (value: string) => value.replace(/ +$/, "");
	return {
		id: (id: string) => id.toLowerCase(),
		identity: (mailboxId: string, host: string, username: string) =>
			JSON.stringify([mailboxId.toLowerCase(), stripAsciiPadding(host), stripAsciiPadding(username)]),
	};
}

/** Backups hold `0`/`1`; a hand-written document may use booleans. */
const isFlag = (value: unknown) => value === 0 || value === 1 || value === true || value === false;
const isIdentityText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTITY_LENGTH;
/**
 * Epoch seconds JavaScript can represent: `new Date(seconds * 1000)` throws a RangeError past 8.64e12 seconds,
 * and the settings API builds a Date straight from these columns.
 */
const MAX_DATE_SECONDS = 8.64e12;
const isTimestamp = (value: unknown) => isIntegerInRange(value, 0, MAX_DATE_SECONDS);
const isOptionalTimestamp = (value: unknown) => value === null || value === undefined || isTimestamp(value);

/**
 * A restore writes whatever the document holds, so this is the one path that could plant a value the API would
 * never produce: a plaintext password in `password_encrypted`, a non-JSON cursor, an out-of-range port. The
 * checks run **before the teardown** and are deliberately broad, because a value refused here costs nothing
 * while one that slips through was written after every existing row was already gone. Where the driver can hold
 * a transaction the restore also rolls back (see `runInTransaction`); on D1 this preflight is the whole guard.
 *
 * It is **format only**: the sealed envelope is never decrypted and never re-encrypted, because a backup made
 * under another MAILFLARE_ENCRYPTION_KEY must still restore — its rows simply need the passwords entered again
 * on this install. And it is not a provenance check: a hand-edited document can hold any canonical base64 in
 * `password_encrypted`, which restores as opaque bytes that fail to decrypt. Restore only backups this install
 * produced, or one you trust as much as the database itself. The message names the row and column only.
 */
function validateExternalAccountRows(document: DatabaseBackupDocument, liveColumns: Set<string> | null, dialect: DatabaseDialect): void {
	const rows = document.tables.external_accounts ?? [];
	const tlsModes = new Set(["implicit-tls", "starttls", "none"]);
	const expectedColumns = liveColumns ? new Set([...liveColumns, ...OMITTED_COLUMNS.external_accounts ?? []]) : null;
	// The rows are inserted after `mailboxes` was replaced by this document, so a mailbox the document does not
	// carry would fail the foreign key after the teardown.
	const mailboxIds = new Set((document.tables.mailboxes ?? []).map((mailbox) => mailbox?.id).filter((id): id is string => typeof id === "string"));
	// Two sets, compared the way the destination compares them — the point is to catch what its index would catch.
	// Copying one rule onto every dialect was wrong both ways: lowercasing `mailbox_id` and trimming the login
	// refused backups PostgreSQL and SQLite would happily store, while `id` on MySQL is case-insensitive and
	// trailing ASCII spaces in the binary tuple columns do not count either. Where the emulation is uncertain it
	// errs towards accepting: a real conflict on MySQL or PostgreSQL is caught by the transaction's rollback.
	const compare = identityComparator(dialect);
	const ids = new Set<string>();
	const identities = new Set<string>();
	rows.forEach((row, index) => {
		// Annotated on the variable so the calls below narrow control flow: every check ends the restore.
		const invalid: (column: string) => never = (column) => {
			throw new BackupRestoreError(`Backup contains an invalid external account record (row ${index + 1}, ${column})`);
		};
		if (expectedColumns) for (const column of Object.keys(row)) if (!expectedColumns.has(column)) invalid(column);
		if (!isIdentityText(row.id)) invalid("id");
		const idKey = compare.id(row.id);
		if (ids.has(idKey)) invalid("id");
		ids.add(idKey);
		if (!isIdentityText(row.mailbox_id)) invalid("mailbox_id");
		if (!mailboxIds.has(row.mailbox_id)) invalid("mailbox_id");
		if (!isIdentityText(row.user_id)) invalid("user_id");
		if (row.protocol !== "imap" && row.protocol !== "pop3") invalid("protocol");
		if (!isIdentityText(row.host)) invalid("host");
		// A host is stored lowercased with no trailing dot, no port and no path (the API normalises before
		// saving), so anything else came from somewhere that is not this app. Rejected, never rewritten.
		if (!isStoredExternalAccountHost(row.host)) invalid("host");
		if (!isIdentityText(row.username)) invalid("username");
		// Portable text: PostgreSQL cannot store a NUL, and a lone surrogate would land as U+FFFD in MySQL.
		if (hasControlCharacter(row.host) || hasUnpairedSurrogate(row.host)) invalid("host");
		if (hasControlCharacter(row.username) || hasUnpairedSurrogate(row.username)) invalid("username");
		if (!isIntegerInRange(row.port, 1, 65535)) invalid("port");
		// `tls_mode` and `enabled` are NOT NULL with a database default: only omission may fall back to it. An
		// explicit null would be bound as NULL and fail the INSERT, so it is refused here — and `tls_mode` must be
		// one of the three strings, never a coerced number or boolean.
		if (row.tls_mode !== undefined && (typeof row.tls_mode !== "string" || !tlsModes.has(row.tls_mode))) invalid("tls_mode");
		if (row.enabled !== undefined && !isFlag(row.enabled)) invalid("enabled");
		// Only the envelope shape: base64 nonce + ciphertext + tag, no plaintext and no truncated value.
		if (!isSealedSecretFormat(row.password_encrypted)) invalid("password_encrypted");
		if (!isOptionalTimestamp(row.last_synced_at)) invalid("last_synced_at");
		if (row.last_error !== null && row.last_error !== undefined && (typeof row.last_error !== "string" || row.last_error.length > 4096 || row.last_error.includes("\u0000"))) invalid("last_error");
		if (!isSyncCursorFormat(row.sync_cursor, row.protocol)) invalid("sync_cursor");
		if (typeof row.sync_cursor === "string" && row.sync_cursor.includes("\u0000")) invalid("sync_cursor");
		// NOT NULL with no database default: an omitted value would fail the insert after the teardown.
		if (!isTimestamp(row.created_at)) invalid("created_at");
		if (!isTimestamp(row.updated_at)) invalid("updated_at");
		const identity = compare.identity(row.mailbox_id, row.host, row.username);
		if (identities.has(identity)) invalid("username");
		identities.add(identity);
	});
}

function toPortableRecord(row: DatabaseRecord): DatabaseRecord {
	return Object.fromEntries(Object.entries(row).map(([column, value]) => [column, typeof value === "boolean" ? (value ? 1 : 0) : value])) as DatabaseRecord;
}
