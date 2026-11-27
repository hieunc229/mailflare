import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { loadFixture } from "./helpers/fixtures.mjs";

// Installs migrated by the old runner (journalled files first, the rest appended) must come through the new order untouched:
// a file is skipped by name, so only a newly added one runs and nothing runs twice.
const fixture = await loadFixture({ name: "migrate-existing", entryPoint: "server/runtime/migrate.ts", mocks: {} });
const { applyMigrations } = await fixture.import();
const dir = mkdtempSync(join(tmpdir(), "mailflare-migrate-existing-"));
after(() => { rmSync(dir, { recursive: true, force: true }); fixture.dispose(); });

/** What the runner did before: the journal's order, then everything it does not list. */
function oldOrder(migrationsDir) {
	const journal = JSON.parse(readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8")).entries.map((entry) => `${entry.tag}.sql`);
	const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
	return [...journal.filter((name) => files.includes(name)), ...files.filter((name) => !journal.includes(name))];
}

test("a database migrated in the old order runs only a newly added file", async () => {
	mkdirSync(join(dir, "meta"));
	writeFileSync(join(dir, "0001_a.sql"), "CREATE TABLE a (id text);");
	writeFileSync(join(dir, "0002_unlisted.sql"), "CREATE TABLE b (id text);");
	writeFileSync(join(dir, "0003_c.sql"), "CREATE TABLE c (id text);");
	writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ entries: [{ tag: "0001_a" }, { tag: "0003_c" }] }));
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)");
	for (const name of oldOrder(dir)) { db.exec(readFileSync(join(dir, name), "utf8")); db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name); }
	assert.deepEqual(db.prepare("SELECT name FROM d1_migrations ORDER BY id").all().map((row) => row.name), ["0001_a.sql", "0003_c.sql", "0002_unlisted.sql"]);
	assert.deepEqual(await applyMigrations({ db }, dir), [], "nothing re-runs");
	writeFileSync(join(dir, "0004_d.sql"), "CREATE TABLE d (id text);");
	assert.deepEqual(await applyMigrations({ db }, dir), ["0004_d.sql"]);
	assert.deepEqual(await applyMigrations({ db }, dir), []);
	db.close();
});

/** Main's last migration when the runner changed. Later files are new to an install made then, whatever order the old runner would have put them in. */
const LAST_APPLIED_BEFORE = 102;
const numberOf = (name) => Number(/^(\d+)/.exec(name)[1]);

test("the repository's own migrations: an install made in the old order up to main's last file re-runs nothing and gets only the later files", async () => {
	const real = join(process.cwd(), "drizzle", "migrations");
	const old = new DatabaseSync(":memory:");
	await applyMigrationsInOldOrder(old, real, (name) => numberOf(name) <= LAST_APPLIED_BEFORE);
	const later = readdirSync(real).filter((name) => name.endsWith(".sql") && numberOf(name) > LAST_APPLIED_BEFORE).sort();
	assert.deepEqual(await applyMigrations({ db: old }, real), later, "only the files added since, in name order, and none of the earlier ones twice");
	assert.deepEqual(await applyMigrations({ db: old }, real), []);
	old.close();
});

test("a fresh install applies every migration in file-name order", async () => {
	const real = join(process.cwd(), "drizzle", "migrations");
	const fresh = new DatabaseSync(":memory:");
	const ran = await applyMigrations({ db: fresh }, real);
	assert.equal(ran.length, readdirSync(real).filter((name) => name.endsWith(".sql")).length);
	assert.deepEqual(ran, [...ran].sort());
	fresh.close();
});

async function applyMigrationsInOldOrder(db, migrationsDir, include) {
	db.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)");
	for (const name of oldOrder(migrationsDir).filter(include)) {
		const statements = readFileSync(join(migrationsDir, name), "utf8").split(/-->\s*statement-breakpoint/g).map((statement) => statement.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
		for (const statement of statements) db.exec(statement);
		db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
	}
}
