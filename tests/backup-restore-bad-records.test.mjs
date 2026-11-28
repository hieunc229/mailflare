import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import Database from "better-sqlite3";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-backup-bad-records-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({
	stdin: { contents: 'export * from "./src/lib/backups/export";', resolveDir: root, loader: "ts" },
	outfile: join(outDir, "backup.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
	banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
const { exportDatabaseRecords, restoreDatabaseRecords } = await import(pathToFileURL(join(outDir, "backup.mjs")).href);
const { migrations } = JSON.parse(readFileSync(join(root, "src/lib/migrations/bundle.json"), "utf8"));

function d1(sqlite) {
	const prepare = (sql) => {
		const statement = {
			values: [],
			bind(...values) { statement.values = values; return statement; },
			async all() { return { results: sqlite.prepare(sql).all(...statement.values), success: true, meta: {} }; },
			async run() { const result = sqlite.prepare(sql).run(...statement.values); return { results: [], success: true, meta: { changes: result.changes } }; },
			async first() { return sqlite.prepare(sql).get(...statement.values) ?? null; },
		};
		return statement;
	};
	return { prepare, async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); } };
}

function database() {
	const sqlite = new Database(":memory:");
	sqlite.pragma("foreign_keys = ON");
	for (const migration of migrations) for (const statement of migration.statements) sqlite.exec(statement);
	sqlite.exec(`
		INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'u1@example.test', 'U', 'x', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d1', 'u1', 'example.test', 'z', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mb1', 'u1', 'd1', 'me', 'personal', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, created_at) VALUES ('m1', 'u1', 'mb1', 'inbound', 'a@example.net', 'me@example.test', 'received', 1);`);
	return sqlite;
}

const encode = (value) => { const bytes = new TextEncoder().encode(JSON.stringify(value)); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); };

for (const [table, bad] of [["users", 1], ["users", null], ["messages", 1], ["messages", null], ["booking_events", 1]]) {
	test(`a non-object ${table} row (${bad}) gets the validation error and changes nothing`, async () => {
		const sqlite = database();
		const document = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(d1(sqlite))));
		document.tables[table] = [bad];
		await assert.rejects(restoreDatabaseRecords(d1(sqlite), encode(document)), new RegExp(`invalid ${table} record`));
		assert.equal(sqlite.prepare("SELECT count(*) AS n FROM users").get().n, 1);
		assert.equal(sqlite.prepare("SELECT count(*) AS n FROM messages").get().n, 1);
	});
}

function rowCounts(sqlite) {
	const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' ORDER BY name").all();
	return Object.fromEntries(tables.map(({ name }) => [name, sqlite.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n]));
}

for (const [table, bad, label] of [
	["users", {}, "an empty object"],
	["users", { unknown_column: 1 }, "only unknown columns"],
	["users", { id: "u2", email: "u2@example.test", name: { nested: true } }, "a nested object value"],
	["users", { id: "u2", email: "u2@example.test", name: ["a"] }, "a nested array value"],
	["messages", {}, "an empty object"],
	["messages", { unknown_column: 1 }, "only unknown columns"],
	["messages", { id: "m2", user_id: "u1", mailbox_id: "mb1", subject: { nested: true } }, "a nested object value"],
	["domains", { unknown_column: 1 }, "only unknown columns"],
]) {
	test(`${table} row with ${label} is rejected before anything is deleted`, async () => {
		const sqlite = database();
		const document = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(d1(sqlite))));
		document.tables[table].push(bad);
		const before = rowCounts(sqlite);
		await assert.rejects(restoreDatabaseRecords(d1(sqlite), encode(document)), new RegExp(`invalid ${table} record`));
		assert.deepEqual(rowCounts(sqlite), before);
		assert.equal(sqlite.prepare("SELECT count(*) AS n FROM users WHERE deleted_at IS NOT NULL").get().n, 0);
	});
}

for (const bad of [{}, 1, "x", true]) {
	test(`a legacy message_bodies of ${JSON.stringify(bad)} gets the validation error and changes nothing`, async () => {
		const sqlite = database();
		const document = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(d1(sqlite))));
		document.tables.message_bodies = bad;
		const before = rowCounts(sqlite);
		await assert.rejects(restoreDatabaseRecords(d1(sqlite), encode(document)), /invalid message_bodies record/);
		assert.deepEqual(rowCounts(sqlite), before);
	});
}

for (const [table, bad, label] of [
	["users", { name: "Only a name" }, "only a name"],
	["users", { id: "u2", email: null, name: "N", password_hash: "x", created_at: 1 }, "a null in a required column"],
	["messages", { id: "m2", user_id: "u1", mailbox_id: "mb1", direction: "inbound" }, "required columns missing"],
	["messages", { id: "m2", user_id: "u1", mailbox_id: "mb1", direction: null, from_addr: "a@example.net", to_addr: "b@example.test", created_at: 1 }, "a null in a required column"],
]) {
	test(`${table} row with ${label} is rejected before anything is deleted`, async () => {
		const sqlite = database();
		const document = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(d1(sqlite))));
		document.tables[table].push(bad);
		const before = rowCounts(sqlite);
		await assert.rejects(restoreDatabaseRecords(d1(sqlite), encode(document)), new RegExp(`invalid ${table} record`));
		assert.deepEqual(rowCounts(sqlite), before);
		assert.equal(sqlite.prepare("SELECT count(*) AS n FROM users WHERE deleted_at IS NOT NULL").get().n, 0);
	});
}

test("an unmodified export still restores", async () => {
	const sqlite = database();
	const document = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(d1(sqlite))));
	await restoreDatabaseRecords(d1(sqlite), encode(document));
	for (const table of ["users", "domains", "mailboxes", "messages"]) assert.equal(sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 1, table);
});

for (const field of ["text_body", "html_body"]) {
	test(`a nested ${field} in a legacy message_bodies row is rejected before anything is deleted`, async () => {
		const sqlite = database();
		const document = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(d1(sqlite))));
		document.tables.message_bodies = [{ message_id: "m1", [field]: { nested: true } }];
		const before = rowCounts(sqlite);
		await assert.rejects(restoreDatabaseRecords(d1(sqlite), encode(document)), /invalid message_bodies record/);
		assert.deepEqual(rowCounts(sqlite), before);
		assert.equal(sqlite.prepare("SELECT count(*) AS n FROM users WHERE deleted_at IS NOT NULL").get().n, 0);
	});
}

test("a booking_events row without slug restores with the slug derived from its id", async () => {
	const sqlite = database();
	const document = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(d1(sqlite))));
	document.tables.booking_events = [{ id: "ab", user_id: "u1", name: "Intro", duration_minutes: 30, created_at: 1, updated_at: 1 }];
	await restoreDatabaseRecords(d1(sqlite), encode(document));
	assert.equal(sqlite.prepare("SELECT slug FROM booking_events WHERE id = 'ab'").get().slug, "6162");
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM users").get().n, 1);
});
