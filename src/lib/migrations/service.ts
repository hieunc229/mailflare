import { isExternalDatabase } from "@/db/external";
import type { DatabaseDialect } from "@/db/dialect";
import sqliteBundle from "./bundle.json";
import mysqlBundle from "./bundle-mysql.json";
import postgresBundle from "./bundle-postgres.json";
import type { BundledMigration, MigrationNameRow, MigrationResult, MigrationStatus } from "./types";

const BUNDLES: Record<DatabaseDialect, BundledMigration[]> = {
	sqlite: sqliteBundle.migrations as BundledMigration[],
	postgres: postgresBundle.migrations as BundledMigration[],
	mysql: mysqlBundle.migrations as BundledMigration[],
};

/** D1 keeps the table name Wrangler uses, so `wrangler d1 migrations apply` and the in-app runner agree. */
const MIGRATION_TABLES: Record<DatabaseDialect, { table: string; create: string; exists: string }> = {
	sqlite: {
		table: "d1_migrations",
		create: "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
		exists: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'",
	},
	postgres: {
		table: "mailflare_migrations",
		create: "CREATE TABLE IF NOT EXISTS mailflare_migrations (id BIGSERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)",
		exists: "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'mailflare_migrations'",
	},
	mysql: {
		table: "mailflare_migrations",
		create: "CREATE TABLE IF NOT EXISTS mailflare_migrations (id BIGINT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(191) NOT NULL UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)",
		exists: "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = database() AND table_name = 'mailflare_migrations'",
	},
};

export function migrationDialect(db: D1Database): DatabaseDialect {
	return isExternalDatabase(db) ? db.config.dialect : "sqlite";
}

/**
 * Rows `<migration>#<statement index>:<hash of its text>` (and `<migration>#start`, written first) record the statements of a MySQL migration that finished. They live
 * in a runner-owned table, not the ledger: an older release treats every ledger row as a migration, and the backup export
 * copies the ledger. The hash keeps a hotfixed statement from being skipped by the mark of its old text.
 */
const STEPS_TABLE = "mailflare_migration_steps";
const STEPS_CREATE = `CREATE TABLE IF NOT EXISTS ${STEPS_TABLE} (name VARCHAR(191) NOT NULL PRIMARY KEY)`;
const LOCK_NAME = "mailflare_migrations";
/** Drivers that hold a real pooled connection, the only kind a lock can be tied to. */
const LOCKING_DRIVERS = new Set(["node-postgres", "postgres-js", "mysql2"]);

const ALREADY_APPLIED_ERRNOS = new Set([1050, 1060, 1061, 1091, 1826]);
const ALREADY_APPLIED_CODES = new Set(["ER_TABLE_EXISTS_ERROR", "ER_DUP_FIELDNAME", "ER_DUP_KEYNAME", "ER_CANT_DROP_FIELD_OR_KEY", "ER_FK_DUP_NAME"]);

/** A statement that already took effect (it finished on the server after the client gave up). */
function isAlreadyAppliedError(error: unknown): boolean {
	const { code, message } = (error ?? {}) as { code?: string; message?: string };
	// PlanetScale's driver error has neither field, but the server's text ends with "(errno N)".
	const errno = (error as { errno?: number } | null)?.errno ?? Number(/\(errno (\d+)\)/.exec(message ?? "")?.[1] ?? NaN);
	if ((!Number.isNaN(errno) && ALREADY_APPLIED_ERRNOS.has(errno)) || (code !== undefined && ALREADY_APPLIED_CODES.has(code))) return true;
	return /already exists|duplicate column name|duplicate key name|can't drop .*; check that (column|key|column\/key) exists/i.test(message ?? "");
}

/** FNV-1a, eight hex digits: enough to tell an edited statement from the one that was recorded. */
function shortHash(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Run statements one by one, recording each finished one so a retry resumes instead of failing on "already exists". */
async function runStatementsWithLedger(db: D1Database, migration: BundledMigration) {
	await db.prepare(STEPS_CREATE).run();
	const rows = await db.prepare(`SELECT name FROM ${STEPS_TABLE}`).all<MigrationNameRow>();
	const done = new Set(rows.results.map((row) => row.name));
	// Only the first unrecorded statement of a migration that got this far may have run without being recorded.
	let mayHaveRun = rows.results.some((row) => row.name.startsWith(`${migration.name}#`));
	// Written before the first statement, so a crash right after it still leaves a trace and the retry may tolerate it.
	if (!mayHaveRun) await db.prepare(`INSERT INTO ${STEPS_TABLE} (name) VALUES (?)`).bind(`${migration.name}#start`).run();
	for (const [index, statement] of migration.statements.entries()) {
		const mark = `${migration.name}#${index}:${shortHash(statement)}`;
		if (done.has(mark)) continue;
		try {
			await db.prepare(statement).run();
		} catch (error) {
			if (!mayHaveRun || !isAlreadyAppliedError(error)) throw error;
			console.warn(`Migration ${migration.name} statement ${index + 1} was already applied; continuing.`);
		}
		mayHaveRun = false;
		await db.prepare(`INSERT INTO ${STEPS_TABLE} (name) VALUES (?)`).bind(mark).run();
	}
}

async function getAppliedMigrationNames(db: D1Database): Promise<string[]> {
	const { table, exists } = MIGRATION_TABLES[migrationDialect(db)];
	const found = await db.prepare(exists).first<MigrationNameRow>();
	if (!found) return [];

	const result = await db.prepare(`SELECT name FROM ${table}`).all<MigrationNameRow>();
	return result.results.map((row) => row.name);
}

export async function getMigrationStatus(db: D1Database): Promise<MigrationStatus> {
	const migrations = BUNDLES[migrationDialect(db)];
	const applied = new Set(await getAppliedMigrationNames(db));
	const committed = new Set(migrations.map((migration) => migration.name));
	const pending = migrations.filter((migration) => !applied.has(migration.name)).map((migration) => migration.name);
	const unknown = [...applied].filter((name) => !committed.has(name)).sort();

	return { ready: pending.length === 0 && unknown.length === 0, pending, unknown };
}

/**
 * One replica migrates at a time, under a lock tied to one pooled connection and held until the work is done. Drivers without
 * such a connection (Neon and PlanetScale over HTTP, PGlite, SQLite, D1) skip it: a lock there would be meaningless or killed.
 * PostgreSQL uses a transaction-scoped lock, so COMMIT or ROLLBACK frees it however the work ends; READ COMMITTED keeps the
 * idle transaction from holding a snapshot that a CONCURRENTLY index build would wait for. MySQL's lock belongs to the session.
 */
async function withMigrationLock<T>(db: D1Database, dialect: DatabaseDialect, work: () => Promise<T>): Promise<T> {
	if (!isExternalDatabase(db) || !LOCKING_DRIVERS.has(db.config.driver) || !db.sqlExecutor.transaction) return work();
	const timedOut = () => new Error("Timed out waiting for another instance to finish migrating.");
	return db.sqlExecutor.transaction(async (connection) => {
		if (dialect === "postgres") {
			await connection.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED", [], "object");
			await connection.query("SET LOCAL lock_timeout = '600s'", [], "object");
			await connection.query("SET LOCAL idle_in_transaction_session_timeout = 0", [], "object");
			await connection.query(`SELECT pg_advisory_xact_lock(hashtext('${LOCK_NAME}'))`, [], "object").catch((error) => {
				throw (error as { code?: string })?.code === "55P03" ? timedOut() : error;
			});
			return work();
		}
		const { rows } = await connection.query(`SELECT GET_LOCK('${LOCK_NAME}', 600) AS acquired`, [], "object");
		if (Number((rows[0] as { acquired?: unknown } | undefined)?.acquired) !== 1) throw timedOut();
		try {
			return await work();
		} finally {
			// A lock that cannot be released stays with its connection, so that connection must not go back to the pool.
			await connection.query(`SELECT RELEASE_LOCK('${LOCK_NAME}')`, [], "object").catch(() => connection.discard?.());
		}
	});
}

export async function applyPendingMigrations(db: D1Database): Promise<MigrationResult> {
	const dialect = migrationDialect(db);
	const migrations = BUNDLES[dialect];
	const { table, create } = MIGRATION_TABLES[dialect];
	const initial = await getMigrationStatus(db);
	if (initial.unknown.length > 0) {
		throw new Error("The database contains migrations that are not part of this Mailflare release.");
	}

	return withMigrationLock(db, dialect, async () => {
		await db.prepare(create).run();
		// Another replica may have applied some while this one waited for the lock.
		const { pending } = await getMigrationStatus(db);
		const applied: string[] = [];

		for (const name of pending) {
			const migration = migrations.find((candidate) => candidate.name === name);
			if (!migration) continue;

			try {
				if (dialect === "mysql") {
					// MySQL cannot make DDL atomic. Statements run one at a time (no wrapping transaction). Each statement is recorded
					// as it finishes and the migration itself last, so a failed migration is retried from where it stopped.
					await runStatementsWithLedger(db, migration);
					await db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).bind(name).run();
					await db.prepare(`DELETE FROM ${STEPS_TABLE} WHERE name LIKE ?`).bind(`${name}#%`).run();
				} else {
					await db.batch([
						db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).bind(name),
						...migration.statements.map((statement) => db.prepare(statement)),
					]);
				}
				applied.push(name);
			} catch (error) {
				const completed = await db.prepare(`SELECT name FROM ${table} WHERE name = ?`).bind(name).first<MigrationNameRow>();
				if (completed) continue;
				throw new Error(`Migration ${name} failed: ${error instanceof Error ? error.message : "Database error"}`);
			}
		}

		// Nothing is pending, so nothing can resume. An older release lists every table and would not know this one; a crash or a
		// rollback can leave it behind, so it goes on every run, not only after one that used it.
		if (dialect === "mysql") await db.prepare(`DROP TABLE IF EXISTS ${STEPS_TABLE}`).run();
		return { ...(await getMigrationStatus(db)), applied };
	});
}
