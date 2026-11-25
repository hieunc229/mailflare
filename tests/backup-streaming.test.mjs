import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import Database from "better-sqlite3";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-backup-streaming-"));
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
const { exportDatabaseRecords, writeDatabaseBackup } = await import(pathToFileURL(join(outDir, "backup.mjs")).href);
const { migrations } = JSON.parse(readFileSync(join(root, "src/lib/migrations/bundle.json"), "utf8"));

function d1(sqlite, log = []) {
	const prepare = (sql) => {
		const statement = {
			values: [],
			bind(...values) { statement.values = values; return statement; },
			async all() { log.push(sql); return { results: sqlite.prepare(sql).all(...statement.values), success: true, meta: {} }; },
			async run() { const result = sqlite.prepare(sql).run(...statement.values); return { results: [], success: true, meta: { changes: result.changes } }; },
		};
		return statement;
	};
	return { prepare };
}

function database(messageCount) {
	const sqlite = new Database(":memory:");
	for (const migration of migrations) for (const statement of migration.statements) sqlite.exec(statement);
	sqlite.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'u1@example.test', 'U', 'x', 1)").run();
	for (let index = 0; index < messageCount; index += 1) {
		sqlite.prepare("INSERT INTO messages (id, user_id, direction, from_addr, to_addr, subject, text_body, created_at) VALUES (?, 'u1', 'inbound', 'a@example.test', 'b@example.test', 's', ?, 1)").run(`m${index}`, "body ".repeat(200));
	}
	return sqlite;
}

function bucket({ failOnPart } = {}) {
	const state = { puts: [], parts: [], aborted: false, completed: null };
	return {
		state,
		async put(key, body, options) {
			state.puts.push({ key, size: body.byteLength ?? body.length });
			state.completed = { key, body: Buffer.from(body) };
			return { size: Buffer.from(body).length };
		},
		async createMultipartUpload(key) {
			return {
				async uploadPart(partNumber, body) {
					if (failOnPart === partNumber) throw new Error("part failed");
					state.parts.push(Buffer.from(body));
					return { partNumber, etag: `e${partNumber}` };
				},
				async abort() { state.aborted = true; },
				async complete(parts) {
					assert.deepEqual(parts.map((part) => part.partNumber), parts.map((_, index) => index + 1));
					state.completed = { key, body: Buffer.concat(state.parts) };
					return { size: state.completed.body.length };
				},
			};
		},
	};
}

test("a large backup is uploaded as equal parts and equals the in-memory export", async () => {
	const sqlite = database(300);
	const expected = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(d1(sqlite))));
	// Independent of the generator: the old way, SELECT * then JSON.stringify.
	assert.deepEqual(expected.tables.messages, sqlite.prepare("SELECT * FROM messages ORDER BY rowid").all());
	const target = bucket();
	const size = await writeDatabaseBackup(d1(sqlite), target, "backups/x.json", [], { partSize: 4096, pageSize: 7 });
	assert.ok(target.state.parts.length > 3);
	const sizes = target.state.parts.map((part) => part.length);
	assert.ok(sizes.slice(0, -1).every((length) => length === 4096));
	assert.ok(sizes.at(-1) <= 4096);
	assert.equal(size, target.state.completed.body.length);
	const written = JSON.parse(target.state.completed.body.toString("utf8"));
	assert.equal(written.tables.messages.length, 300);
	assert.deepEqual(Object.keys(written.tables), Object.keys(expected.tables));
	assert.deepEqual(written.tables.messages, expected.tables.messages);
	assert.deepEqual(written.includedTables, expected.includedTables);
});

const messageReads = (log) => log.filter((sql) => /FROM messages\b/.test(sql));

function bodiesDatabase(count, bodyChars) {
	const sqlite = database(0);
	for (let index = 0; index < count; index += 1) {
		sqlite.prepare("INSERT INTO messages (id, user_id, direction, from_addr, to_addr, subject, text_body, created_at) VALUES (?, 'u1', 'inbound', 'a@example.test', 'b@example.test', 's', ?, 1)").run(`m${index}`, "x".repeat(bodyChars));
	}
	return sqlite;
}

test("no query reads a whole messages table at once", async () => {
	const log = [];
	await writeDatabaseBackup(d1(database(50), log), bucket(), "k", [], { pageBytes: 20_000, indexRows: 10 });
	const reads = messageReads(log);
	assert.ok(reads.length > 2);
	assert.ok(reads.every((sql) => /LIMIT|rowid <=/.test(sql)));
});

test("message page count scales with bytes, not rows", async () => {
	const options = { pageBytes: 100_000, indexRows: 1000 };
	// Same row count (200), 100x the bytes.
	const small = [];
	await writeDatabaseBackup(d1(bodiesDatabase(200, 100), small), bucket(), "k", [], options);
	const large = [];
	await writeDatabaseBackup(d1(bodiesDatabase(200, 10_000), large), bucket(), "k", [], options);
	// Many small rows fit one body page (plus one size-index page); 2 MB of bodies need 20+ pages.
	assert.equal(messageReads(small).length, 2);
	assert.ok(messageReads(large).length >= 20, `large: ${messageReads(large).length}`);
});

test("a large message table stays far below D1's 1000 queries per invocation", async () => {
	const log = [];
	await writeDatabaseBackup(d1(bodiesDatabase(5000, 50), log), bucket(), "k", [], { pageBytes: 4 * 1024 * 1024, indexRows: 2000 });
	assert.ok(log.length < 80, `queries: ${log.length}`);
});

test("one message larger than the page budget is read alone and kept", async () => {
	const sqlite = bodiesDatabase(3, 10);
	sqlite.prepare("UPDATE messages SET text_body = ? WHERE id = 'm1'").run("y".repeat(50_000));
	const target = bucket();
	await writeDatabaseBackup(d1(sqlite), target, "k", [], { pageBytes: 1000, indexRows: 2 });
	const written = JSON.parse(target.state.completed.body.toString("utf8"));
	assert.deepEqual(written.tables.messages.map((row) => row.id), ["m0", "m1", "m2"]);
	assert.equal(written.tables.messages[1].text_body.length, 50_000);
});

test("rows with rowid 0 or below are not skipped", async () => {
	const sqlite = database(0);
	sqlite.prepare("INSERT INTO messages (rowid, id, user_id, direction, from_addr, to_addr, created_at) VALUES (0, 'zero', 'u1', 'inbound', 'a@example.test', 'b@example.test', 1)").run();
	sqlite.prepare("INSERT INTO messages (rowid, id, user_id, direction, from_addr, to_addr, created_at) VALUES (5, 'five', 'u1', 'inbound', 'a@example.test', 'b@example.test', 1)").run();
	const target = bucket();
	await writeDatabaseBackup(d1(sqlite), target, "k", []);
	const written = JSON.parse(target.state.completed.body.toString("utf8"));
	assert.deepEqual(written.tables.messages.map((row) => row.id), ["zero", "five"]);
});

test("a small backup is a single put", async () => {
	const target = bucket();
	await writeDatabaseBackup(d1(database(1)), target, "k", []);
	assert.equal(target.state.puts.length, 1);
});

test("a failed part aborts the upload", async () => {
	const target = bucket({ failOnPart: 2 });
	await assert.rejects(writeDatabaseBackup(d1(database(300)), target, "k", [], { partSize: 4096, pageSize: 7 }), /part failed/);
	assert.equal(target.state.aborted, true);
});

const reads = (log, table) => log.filter((sql) => new RegExp(`FROM ${table}\\b`).test(sql) && !/sqlite_master/.test(sql));

function jobsDatabase(count, payloadChars) {
	const sqlite = database(0);
	for (let index = 0; index < count; index += 1) {
		sqlite.prepare("INSERT INTO outbound_jobs (id, user_id, status, payload, created_at, updated_at) VALUES (?, 'u1', 'sent', ?, 1, 1)").run(`j${index}`, JSON.stringify({ html: "h".repeat(payloadChars) }));
	}
	return sqlite;
}

test("outbound_jobs with large payloads are paged by bytes, not 500 rows", async () => {
	// 100 jobs of 100 KB: the old 500-row page read all 10 MB in one query.
	const log = [];
	const sqlite = jobsDatabase(100, 100_000);
	const target = bucket();
	await writeDatabaseBackup(d1(sqlite, log), target, "k", [], { pageBytes: 500_000 });
	const pageReads = reads(log, "outbound_jobs").filter((sql) => /rowid <=/.test(sql));
	assert.ok(pageReads.length >= 15, `range reads: ${pageReads.length}`);
	const written = JSON.parse(target.state.completed.body.toString("utf8"));
	assert.deepEqual(written.tables.outbound_jobs, sqlite.prepare("SELECT * FROM outbound_jobs ORDER BY rowid").all());
});

test("every table with text columns is byte-paged and none is read whole", async () => {
	const sqlite = database(0);
	sqlite.prepare("INSERT INTO webhooks (id, user_id, url, secret, events, created_at) VALUES ('w1', 'u1', 'https://x.test', 's', '[]', 1)").run();
	for (let index = 0; index < 40; index += 1) sqlite.prepare("INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, status, attempts, created_at) VALUES (?, 'w1', 'e', ?, 'ok', 1, 1)").run(`d${index}`, "p".repeat(50_000));
	const log = [];
	const target = bucket();
	await writeDatabaseBackup(d1(sqlite, log), target, "k", [], { pageBytes: 300_000 });
	assert.ok(reads(log, "webhook_deliveries").filter((sql) => /rowid <=/.test(sql)).length >= 6);
	const written = JSON.parse(target.state.completed.body.toString("utf8"));
	assert.equal(written.tables.webhook_deliveries.length, 40);
	// No table with a text column is ever read with a row LIMIT page or whole.
	assert.ok(!log.some((sql) => /FROM (outbound_jobs|dav_cards|calendar_events|webhook_deliveries|messages) WHERE rowid > \? ORDER BY rowid LIMIT/.test(sql) && !/AS bytes/.test(sql)));
});

test("a whole backup of a mostly empty database costs about one query per table (under 100)", async () => {
	const log = [];
	await writeDatabaseBackup(d1(database(10), log), bucket(), "k", []);
	assert.ok(log.length < 100, `queries: ${log.length}`);
});
