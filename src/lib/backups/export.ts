import { dialectOf, listColumnNames, listTableNames, quoteIdentifier } from "@/db/introspect";
import type { DatabaseDialect } from "@/db/dialect";
import type { BackupTableGroupId, DatabaseBackupDocument, DatabaseBackupTable, DatabaseRecord } from "./types";
import { mergeLegacyMessageBodies } from "./utils";
import { BACKUP_TABLE_GROUPS, getSelectedBackupTables } from "./table-groups";

export const BACKUP_TABLES: DatabaseBackupTable[] = ["users", "user_compose_preferences", "domains", "domain_tracking_hosts", "email_suppressions", "domain_deliverability", "mailboxes", "mailbox_access", "contacts", "contact_details", "dav_collections", "dav_cards", "folders", "mailbox_promotion_settings", "mailbox_sender_preferences", "api_keys", "messages", "message_attachments", "shared_attachment_links", "outbound_jobs", "message_tracking", "message_opens", "follow_ups", "conversation_notes", "routing_rules", "webhooks", "webhook_deliveries", "sessions", "audit_logs", "backup_settings", "backups", "app_settings", "deliverability_reports", "dmarc_daily_stats", "tls_daily_stats", "deliverability_alerts", "license_settings", "email_templates", "calendar_events", "dav_calendar_objects", "calendar_event_overrides", "calendar_occurrence_responses", "calendar_invite_tombstones", "booking_events", "booking_confirmation_templates", "auto_reply_deliveries", "spam_token_stats", "spam_reputation", "spam_feedback", "mailbox_aliases", "password_reset_tokens", "mfa_recovery_codes", "login_challenges", "passkey_credentials", "mailbox_agent_settings", "agent_conversations", "agent_chat_messages", "agent_jobs", "agent_draft_metadata", "agent_send_approvals", "mcp_key_mailboxes", "ai_usage", "drive_items", "drive_upload_parts", "drive_shares"];
/**
 * Tables every backup document must contain. Tables added to BACKUP_TABLES
 * after the format shipped are absent from older documents, so they stay
 * optional here and are filled in as empty on restore.
 */
/** Added by migrations 0068 and later; databases that have not applied them yet back up and restore without them. */
const LATER_MIGRATION_TABLES: DatabaseBackupTable[] = ["domain_tracking_hosts", "message_tracking", "message_opens", "follow_ups", "conversation_notes", "user_compose_preferences", "booking_confirmation_templates", "mailbox_promotion_settings", "mailbox_sender_preferences", "dav_collections", "dav_cards", "dav_calendar_objects", "email_suppressions", "domain_deliverability", "deliverability_reports", "dmarc_daily_stats", "deliverability_alerts", "tls_daily_stats", "contact_details"];
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

/** Rows per query for ordinary tables. */
const EXPORT_PAGE_ROWS = 500;
/**
 * Every D1/SQLite table with a text or blob column is read by bytes, not rows: a message body runs to 1.3 MB, a
 * sent mail's payload in outbound_jobs holds its whole HTML, a vCard or calendar object up to 128K characters, and a
 * fixed 500-row page of those would not fit the isolate's memory. D1 also allows only 1000 queries per invocation, so
 * small rows must not get small pages either. Row sizes come from a cheap index query (`EXPORT_INDEX_ROWS` rows per
 * page, summing the length of every text/blob column), then rowid ranges of about `EXPORT_PAGE_BYTES` are read.
 * The column list comes from the live schema, so a table or column added later is covered without a code change.
 * Queries: 1 (schema) + per table one index query and one range read per index page, plus bytes / 4 MiB for
 * oversize ranges; about 2 * tables + 2 * rows / 2000 + bytes / 4 MiB.
 */
const EXPORT_INDEX_ROWS = 2000;
const EXPORT_PAGE_BYTES = 4 * 1024 * 1024;
const TEXT_TYPE = /TEXT|CHAR|CLOB|BLOB|^$/i;
/** Text and blob columns of every table, in one query; PRAGMA table_info per table if the table-valued form is refused. */
async function textColumnsByTable(db: D1Database, tables: string[]): Promise<Map<string, string[]>> {
	const columns = new Map<string, string[]>();
	const add = (table: string, column: string, type: string) => {
		if (TEXT_TYPE.test(type)) columns.set(table, [...(columns.get(table) ?? []), column]);
	};
	try {
		const rows = (await db.prepare("SELECT m.name AS tbl, p.name AS col, p.type AS type FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table'").all<{ tbl: string; col: string; type: string }>()).results;
		for (const row of rows) add(row.tbl, row.col, row.type ?? "");
	} catch {
		for (const table of tables) for (const row of (await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string; type: string }>()).results) add(table, row.name, row.type ?? "");
	}
	return columns;
}
type BackupPaging = { pageSize?: number; pageBytes?: number; indexRows?: number };
/** R2 multipart parts must all be the same size (5 MiB minimum) except the last. */
const UPLOAD_PART_BYTES = 8 * 1024 * 1024;

/**
 * Yields the backup document as JSON text in pieces, one table page at a time, so the whole database never sits in
 * memory. D1/SQLite is read by `rowid` keyset pages; PostgreSQL and MySQL (self-hosted, with ordinary memory) read
 * one table per query and emit it in pieces.
 */
async function* backupDocumentPieces(db: D1Database, excludedGroups: BackupTableGroupId[], paging: BackupPaging = {}): AsyncGenerator<string> {
	const dialect = dialectOf(db);
	const databaseTables = await assertBackupTablesCoverDatabase(db);
	const selected = getSelectedBackupTables(excludedGroups);
	const includedTables = BACKUP_TABLES.filter((table) => selected.has(table));
	if (!includedTables.length) throw new Error("Select at least one backup table group");
	yield `{"format":"mailflare-database-backup","version":2,"createdAt":${JSON.stringify(new Date().toISOString())},"includedTables":${JSON.stringify(includedTables)},"tables":{`;
	const textColumns = dialect === "sqlite" ? await textColumnsByTable(db, includedTables) : new Map<string, string[]>();
	let firstTable = true;
	for (const table of includedTables) {
		yield `${firstTable ? "" : ","}${JSON.stringify(table)}:[`;
		firstTable = false;
		if ((table === "shared_attachment_links" || table === "booking_events" || table === "passkey_credentials" || table.startsWith("drive_") || LATER_MIGRATION_TABLES.includes(table)) && !databaseTables.has(table)) {
			yield "]";
			continue;
		}
		const omitted = OMITTED_COLUMNS[table];
		const limit = paging.pageSize ?? EXPORT_PAGE_ROWS;
		// Backups hold SQLite-style values whichever database wrote them, so they restore anywhere.
		const toRow = (record: DatabaseRecord) => {
			const row = dialect === "sqlite" ? record : toPortableRecord(record);
			return omitted ? Object.fromEntries(Object.entries(row).filter(([column]) => !omitted.includes(column))) : row;
		};
		let first = true;
		const emit = (rows: DatabaseRecord[]) => {
			const text = rows.map((row) => JSON.stringify(toRow(row))).join(",");
			const piece = text && !first ? `,${text}` : text;
			if (text) first = false;
			return piece;
		};
		const sizeColumns = textColumns.get(table);
		if (sizeColumns?.length) {
			const rowBytesSql = sizeColumns.map((column) => `COALESCE(LENGTH(CAST(${quoteIdentifier(dialect, column)} AS BLOB)), 0)`).join(" + ");
			const pageBytes = paging.pageBytes ?? EXPORT_PAGE_BYTES;
			const indexRows = paging.indexRows ?? EXPORT_INDEX_ROWS;
			let after = Number.MIN_SAFE_INTEGER;
			for (;;) {
				const index = (await db.prepare(`SELECT rowid AS r, ${rowBytesSql} AS bytes FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`).bind(after, indexRows).all<{ r: number; bytes: number }>()).results;
				if (!index.length) break;
				// Cut the index page into rowid ranges of about pageBytes; a single larger message is its own range.
				let rangeStart = after;
				let rangeBytes = 0;
				for (let position = 0; position < index.length; position += 1) {
					rangeBytes += Number(index[position].bytes);
					if (rangeBytes < pageBytes && position < index.length - 1) continue;
					const rangeEnd = Number(index[position].r);
					const rows = (await db.prepare(`SELECT rowid AS __rowid, * FROM ${table} WHERE rowid > ? AND rowid <= ? ORDER BY rowid`).bind(rangeStart, rangeEnd).all<DatabaseRecord & { __rowid: number }>()).results;
					const piece = emit(rows.map(({ __rowid, ...row }) => row));
					if (piece) yield piece;
					rangeStart = rangeEnd;
					rangeBytes = 0;
				}
				after = Number(index[index.length - 1].r);
				if (index.length < indexRows) break;
			}
		} else if (dialect === "sqlite") {
			let after = Number.MIN_SAFE_INTEGER;
			for (;;) {
				const result = await db.prepare(`SELECT rowid AS __rowid, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`).bind(after, limit).all<DatabaseRecord & { __rowid: number }>();
				if (!result.results.length) break;
				after = Number(result.results[result.results.length - 1].__rowid);
				const piece = emit(result.results.map(({ __rowid, ...row }) => row));
				if (piece) yield piece;
				if (result.results.length < limit) break;
			}
		} else {
			const rows = (await db.prepare(`SELECT * FROM ${table}`).all<DatabaseRecord>()).results;
			for (let index = 0; index < rows.length; index += limit) {
				const piece = emit(rows.slice(index, index + limit));
				if (piece) yield piece;
			}
		}
		yield "]";
	}
	yield "}}";
}

export async function exportDatabaseRecords(db: D1Database, excludedGroups: BackupTableGroupId[] = []): Promise<Uint8Array> {
	const encoder = new TextEncoder();
	let text = "";
	for await (const piece of backupDocumentPieces(db, excludedGroups)) text += piece;
	return encoder.encode(text);
}

/**
 * Writes the backup document to `key` without holding it whole: pieces are cut into equal parts of a multipart
 * upload, so memory stays near one part plus one page of rows. A document smaller than one part is a plain put.
 * Returns the stored size.
 */
export async function writeDatabaseBackup(
	db: D1Database,
	bucket: R2Bucket,
	key: string,
	excludedGroups: BackupTableGroupId[],
	options: { customMetadata?: Record<string, string>; partSize?: number } & BackupPaging = {},
): Promise<number> {
	const partSize = options.partSize ?? UPLOAD_PART_BYTES;
	const encoder = new TextEncoder();
	const putOptions = { httpMetadata: { contentType: "application/json" }, customMetadata: options.customMetadata };
	let pending: Uint8Array[] = [];
	let pendingBytes = 0;
	let upload: R2MultipartUpload | null = null;
	const parts: R2UploadedPart[] = [];
	// Takes exactly `size` bytes off the front of the pending chunks.
	const take = (size: number) => {
		const out = new Uint8Array(size);
		let offset = 0;
		while (offset < size) {
			const chunk = pending[0];
			const used = Math.min(chunk.length, size - offset);
			out.set(chunk.subarray(0, used), offset);
			offset += used;
			if (used === chunk.length) pending.shift();
			else pending[0] = chunk.subarray(used);
		}
		pendingBytes -= size;
		return out.buffer as ArrayBuffer;
	};
	try {
		for await (const piece of backupDocumentPieces(db, excludedGroups, options)) {
			const bytes = encoder.encode(piece);
			pending.push(bytes);
			pendingBytes += bytes.length;
			while (pendingBytes >= partSize) {
				upload ??= await bucket.createMultipartUpload(key, putOptions);
				parts.push(await upload.uploadPart(parts.length + 1, take(partSize)));
			}
		}
		if (!upload) return (await bucket.put(key, take(pendingBytes), putOptions)).size;
		if (pendingBytes) parts.push(await upload.uploadPart(parts.length + 1, take(pendingBytes)));
		return (await upload.complete(parts)).size;
	} catch (error) {
		await upload?.abort().catch(() => undefined);
		throw error;
	} finally {
		pending = [];
	}
}

export async function restoreDatabaseRecords(db: D1Database, content: ArrayBuffer): Promise<void> {
	const document = parseDatabaseBackup(content);
	// Format 1 predates the drive group, so its writers could not have named its
	// tables in includedTables; only format 2 documents must cover every group.
	if (document.includedTables && !groupsForDocumentVersion(document.version).every((group) => group.tables.some((table) => document.includedTables?.includes(table)))) throw new Error("This backup contains selected table groups only. Restore requires a backup that includes every table group.");
	mergeLegacyMessageBodies(document);
	fillMissingBackupTables(document);
	validateDatabaseBackup(document);
	const dialect = dialectOf(db);
	const existing = await listTableNames(db);
	const sharedLinksTable = existing.has("shared_attachment_links");
	if (!sharedLinksTable && document.tables.shared_attachment_links?.length) throw new Error("Apply pending database migrations before restoring shared attachment links.");
	const bookingTable = existing.has("booking_events");
	if (!bookingTable && document.tables.booking_events?.length) throw new Error("Apply pending database migrations before restoring booking events.");
	const passkeyTable = existing.has("passkey_credentials");
	if (!passkeyTable && document.tables.passkey_credentials?.length) throw new Error("Apply pending database migrations before restoring passkeys.");
	// Drive migrations ship later than the backup format, so an installation can have a database without them yet.
	const driveTableNames = ["drive_items", "drive_upload_parts", "drive_shares"].filter((table) => existing.has(table));
	if (["drive_items", "drive_upload_parts", "drive_shares"].some((table) => document.tables[table]?.length) && driveTableNames.length !== 3) throw new Error("Apply pending database migrations before restoring the Drive tables.");
	const laterTableNames = LATER_MIGRATION_TABLES.filter((table) => existing.has(table));
	const unmigrated = LATER_MIGRATION_TABLES.filter((table) => document.tables[table]?.length && !laterTableNames.includes(table));
	if (unmigrated.length) throw new Error(`Apply pending database migrations before restoring ${unmigrated.join(", ")}.`);
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
	// Mark users deleted before removing them: the passkey trigger permits the
	// cascade to remove the last credential only for an account that is being
	// purged. Deleting users first also empties the table the restore inserts
	// into last, so the rest of the teardown has no live accounts to protect.
	await db.prepare("UPDATE users SET deleted_at = ?").bind(Math.floor(Date.now() / 1000)).run();
	await db.prepare("DELETE FROM users").run();
	for (const table of [...restoreTables].reverse()) {
		if (table === "users") continue;
		await db.prepare(`DELETE FROM ${table}`).run();
	}
	// Derived DAV state of the old data: the triggers rebuild the log as rows are restored, and a new epoch makes every
	// client resync. Explicit because MySQL does not fire triggers for FK cascades, so the teardown above leaves stale rows there.
	for (const table of ["dav_changes", "dav_sync_state"]) if (existing.has(table)) await db.prepare(`DELETE FROM ${table}`).run();
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
			const statements = rows.slice(index, index + INSERT_BATCH_SIZE).map((row) => createInsertStatement(db, dialect, table, row, columns));
			// MySQL checks foreign keys per statement, so the batch suspends them for its own connection.
			if (statements.length > 0) await db.batch(dialect === "mysql" ? [db.prepare("SET FOREIGN_KEY_CHECKS = 0"), ...statements, db.prepare("SET FOREIGN_KEY_CHECKS = 1")] : statements);
		}
	}
}

function parseDatabaseBackup(content: ArrayBuffer): DatabaseBackupDocument {
	let value: unknown;
	try { value = JSON.parse(new TextDecoder().decode(content)); } catch { throw new Error("The selected file is not a valid Mailflare backup"); }
	if (!isDatabaseBackupDocument(value)) throw new Error("The selected file is not a valid Mailflare backup");
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
	if (columns.length === 0) throw new Error(`Backup contains an invalid ${table} record`);
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

function validateDatabaseBackup(document: DatabaseBackupDocument): void {
	for (const table of BACKUP_TABLES) {
		for (const row of document.tables[table] ?? []) {
			if (!row || typeof row !== "object" || Array.isArray(row)) {
				throw new Error(`Backup contains an invalid ${table} record`);
			}
		}
	}
}

function toPortableRecord(row: DatabaseRecord): DatabaseRecord {
	return Object.fromEntries(Object.entries(row).map(([column, value]) => [column, typeof value === "boolean" ? (value ? 1 : 0) : value])) as DatabaseRecord;
}
