import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-rdate-overrides-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { mergeRdateOverrides } from "./src/lib/calendar/invite-store.ts";
		`,
		resolveDir: root,
		sourcefile: "rdate-overrides-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	alias: { "next/headers": "next/headers.js", "next/server": "next/server.js", "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	packages: "external",
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, getDb, mergeRdateOverrides } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const START = 1_800_000_000_000;
const invite = (count, offset = 1) => ({
	startsAt: new Date(START),
	endsAt: new Date(START + 3_600_000),
	rdateDates: Array.from({ length: count }, (_, index) => new Date(START + (index + offset) * 86_400_000)),
});

async function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec("INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('u', 'u@example.com', 'hash', 'U', 1)");
	database.db.exec("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, response_status, created_at, updated_at) VALUES ('evt', 'u', 'Series', 1, 2, 'accepted', 1, 1)");
	return { database, db: getDb({ DB: database }) };
}
const count = (database) => database.db.prepare("SELECT count(*) AS n FROM calendar_event_overrides WHERE event_id = 'evt'").get().n;

test("rdate overrides are inserted in one pass", async (t) => {
	const { database, db } = await fixture(t);
	await mergeRdateOverrides(db, "evt", invite(10));
	assert.equal(count(database), 10);
	for (const row of database.db.prepare("SELECT starts_at, ends_at FROM calendar_event_overrides").all()) assert.equal(row.ends_at - row.starts_at, 3600);
});

test("stored overrides are kept and not duplicated", async (t) => {
	const { database, db } = await fixture(t);
	const input = invite(3);
	database.db.prepare("INSERT INTO calendar_event_overrides (id, event_id, occurrence_ms, starts_at, ends_at, created_at, updated_at) VALUES ('o1', 'evt', ?, 1, 2, 1, 1)").run(input.rdateDates[0].getTime());
	await mergeRdateOverrides(db, "evt", input);
	assert.equal(count(database), 3);
	assert.equal(database.db.prepare("SELECT starts_at FROM calendar_event_overrides WHERE id = 'o1'").get().starts_at, 1);
});

test("a flood of RDATEs is capped", async (t) => {
	const { database, db } = await fixture(t);
	await mergeRdateOverrides(db, "evt", invite(1000));
	assert.equal(count(database), 100);
});

test("duplicate RDATE values in one invitation store one row", async (t) => {
	const { database, db } = await fixture(t);
	const input = invite(2);
	input.rdateDates.push(new Date(input.rdateDates[0]));
	await mergeRdateOverrides(db, "evt", input);
	assert.equal(count(database), 2);
});
