import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SqliteDatabase } from "./sqlite-database";

/**
 * Apply the repository's D1 migrations to the local database in journal
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

	let order: string[];
	try {
		const journal = JSON.parse(await readFile(join(migrationsDir, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
		order = journal.entries.map((entry) => `${entry.tag}.sql`);
	} catch {
		order = [];
	}
	const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
	// Anything the journal does not list (hand-written migrations) runs after it, in name order.
	const names = [...order.filter((name) => files.includes(name)), ...files.filter((name) => !order.includes(name))];

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
