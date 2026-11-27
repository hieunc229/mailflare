import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SqliteDatabase } from "./sqlite-database";

/** Leading number first, then the whole name: wrangler's `compareMigrationPaths`, so `9_a` comes before `0010_a` and `100_z`. A name with no number sorts last. */
function compareMigrationNames(a: string, b: string): number {
	const number = (name: string) => { const match = /^(\d+)/.exec(name); return match ? Number(match[1]) : Number.POSITIVE_INFINITY; };
	const byNumber = number(a) === number(b) ? 0 : number(a) < number(b) ? -1 : 1;
	return byNumber || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Apply the repository's D1 migrations to the local database in file-name
 * order, recording them in `d1_migrations` exactly as Wrangler does. A fresh
 * database and an upgraded one therefore follow the same path, and the
 * hand-copied bootstrap schema in src/lib/setup/migration.ts is never used
 * here.
 */
export async function applyMigrations(database: SqliteDatabase, migrationsDir: string): Promise<string[]> {
	const db = database.db;
	db.exec(
		"CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)",
	);
	const applied = new Set(db.prepare("SELECT name FROM d1_migrations").all().map((row) => (row as { name: string }).name));

	// File-name order, as `wrangler d1 migrations apply` runs them. The journal lists them in that order too, but it leaves out some
	// early migrations (0021, 0041 to 0050) that later journalled ones may alter (a column added to the 0049 `booking_events`), so
	// running the journalled ones first would try to alter tables that do not exist yet. Installs made in the old order skip every file by name.
	const names = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort(compareMigrationNames);

	const ran: string[] = [];
	for (const name of names) {
		if (applied.has(name)) continue;
		const sql = await readFile(join(migrationsDir, name), "utf8");
		const statements = sql
			.split(/-->\s*statement-breakpoint/g)
			.map((statement) => statement.trim())
			.filter((statement) => statement && !/^--/.test(statement.replace(/\n.*/gs, "")) || statement.includes("\n"));
		db.exec("BEGIN");
		try {
			for (const statement of statements) {
				const clean = statement.replace(/^\s*--.*$/gm, "").trim();
				if (clean) db.exec(clean);
			}
			db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw new Error(`Migration ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		ran.push(name);
	}
	return ran;
}
