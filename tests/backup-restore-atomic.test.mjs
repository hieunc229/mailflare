import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { memoryBucket } from "./helpers/memory-bucket.mjs";
import Database from "better-sqlite3";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-backup-atomic-"));
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

/** Like D1: each statement on its own commits, `batch` is one transaction that rolls back on any failure. */
function d1(sqlite) {
	const prepare = (sql) => {
		const statement = {
			sql,
			values: [],
			bind(...values) { statement.values = values; return statement; },
			async all() { return { results: sqlite.prepare(sql).all(...statement.values), success: true, meta: {} }; },
			async run() { const result = sqlite.prepare(sql).run(...statement.values); return { results: [], success: true, meta: { changes: result.changes } }; },
			async first() { return sqlite.prepare(sql).get(...statement.values) ?? null; },
		};
		return statement;
	};
	return {
		prepare,
		async batch(statements) {
			sqlite.exec("BEGIN");
			try {
				const results = [];
				for (const statement of statements) results.push(await statement.run());
				sqlite.exec("COMMIT");
				return results;
			} catch (error) {
				sqlite.exec("ROLLBACK");
				throw error;
			}
		},
	};
}

function database() {
	const sqlite = new Database(":memory:");
	sqlite.pragma("foreign_keys = ON");
	for (const migration of migrations) for (const statement of migration.statements) sqlite.exec(statement);
	sqlite.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'u1@example.test', 'U', 'x', 1)").run();
	sqlite.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.test', 'z', 1)").run();
	return sqlite;
}

const buffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

const inventory = (sqlite) => ({
	users: sqlite.prepare("SELECT count(*) AS n FROM users WHERE deleted_at IS NULL").get().n,
	domains: sqlite.prepare("SELECT count(*) AS n FROM domains").get().n,
	contacts: sqlite.prepare("SELECT count(*) AS n FROM contacts").get().n,
});
const encode = (document) => buffer(new TextEncoder().encode(JSON.stringify(document)));
const exported = async (sqlite) => JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(d1(sqlite))));

test("an invalid row anywhere in the backup is rejected before anything is deleted", async () => {
	const sqlite = database();
	sqlite.prepare("INSERT INTO contacts (id, user_id, email, created_at) VALUES ('c1', 'u1', 'c@example.test', 1)").run();
	const before = inventory(sqlite);
	const bucket = memoryBucket();
	const document = await exported(sqlite);
	// The invalid row is in a late table (restored last), so a restore that validates as it inserts would already have torn down.
	document.tables.contacts.push({ id: "c2", user_id: "u1", email: { not: "a scalar" }, created_at: 1 });
	await assert.rejects(restoreDatabaseRecords(d1(sqlite), encode(document), { bucket }), /invalid contacts record/);
	assert.deepEqual(inventory(sqlite), before);
	assert.equal(bucket.puts.length, 0, "no safety backup is needed when validation fails");
});

test("a row with no usable column is rejected before anything is deleted", async () => {
	const sqlite = database();
	const before = inventory(sqlite);
	const document = await exported(sqlite);
	document.tables.domains.push({});
	await assert.rejects(restoreDatabaseRecords(d1(sqlite), encode(document), { bucket: memoryBucket() }), /invalid domains record/);
	assert.deepEqual(inventory(sqlite), before);
});

test("a safety backup of the current database is written before the first delete", async () => {
	const sqlite = database();
	sqlite.prepare("INSERT INTO contacts (id, user_id, email, created_at) VALUES ('c1', 'u1', 'c@example.test', 1)").run();
	const document = await exported(sqlite);
	sqlite.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d2', 'u1', 'extra.test', 'z', 1)").run();
	const events = [];
	const target = d1(sqlite);
	const prepare = target.prepare;
	target.prepare = (sql) => {
		if (/^(DELETE|UPDATE users)/.test(sql)) events.push("delete");
		return prepare(sql);
	};
	const bucket = memoryBucket({ onPut: () => events.push("safety-put") });
	const result = await restoreDatabaseRecords(target, encode(document), { bucket });
	assert.equal(events[0], "safety-put");
	assert.ok(events.includes("delete"));
	assert.equal(bucket.puts.length, 1);
	assert.equal(result.safetyBackupKey, bucket.puts[0]);
	// The safety backup is the database as it was before the restore, including the domain the restore removed.
	const safety = JSON.parse(new TextDecoder().decode(await (await bucket.get(result.safetyBackupKey)).arrayBuffer()));
	assert.deepEqual(safety.tables.domains.map((row) => row.id).sort(), ["d1", "d2"]);
	assert.deepEqual(sqlite.prepare("SELECT id FROM domains").all().map((row) => row.id), ["d1"]);
});

test("if the safety backup cannot be written the restore does not start", async () => {
	const sqlite = database();
	const before = inventory(sqlite);
	const document = await exported(sqlite);
	await assert.rejects(restoreDatabaseRecords(d1(sqlite), encode(document), { bucket: memoryBucket({ failPut: true }) }), /safety backup/i);
	assert.deepEqual(inventory(sqlite), before);
});

test("a failure after the teardown names the safety backup, which restores the old data", async () => {
	const sqlite = database();
	sqlite.prepare("INSERT INTO contacts (id, user_id, email, created_at) VALUES ('c1', 'u1', 'c@example.test', 1)").run();
	const before = inventory(sqlite);
	const bucket = memoryBucket();
	const document = await exported(sqlite);
	// Passes validation, but violates a foreign key during the inserts (the teardown has already run by then).
	document.tables.mailboxes = [{ id: "m1", user_id: "u1", domain_id: "missing", local_part: "a", created_at: 1 }];
	await assert.rejects(restoreDatabaseRecords(d1(sqlite), encode(document), { bucket }), (error) => {
		assert.match(error.message, /backups\/pre-restore\//);
		return true;
	});
	assert.equal(bucket.puts.length, 1);
	const safety = await (await bucket.get(bucket.puts[0])).arrayBuffer();
	await restoreDatabaseRecords(d1(sqlite), safety, { bucket: memoryBucket() });
	assert.deepEqual(inventory(sqlite), before);
});

test("the restore inserts in chunks, not one batch", async () => {
	const sqlite = database();
	for (let index = 0; index < 120; index += 1) sqlite.prepare("INSERT INTO contacts (id, user_id, email, created_at) VALUES (?, 'u1', ?, 1)").run(`c${index}`, `c${index}@example.test`);
	const document = await exported(sqlite);
	const target = d1(sqlite);
	const sizes = [];
	const batch = target.batch;
	target.batch = (statements) => {
		sizes.push(statements.length);
		return batch(statements);
	};
	await restoreDatabaseRecords(target, encode(document), { bucket: memoryBucket() });
	// Small rows go in one byte-bounded batch (fewer D1 queries), far under the 500-statement cap.
	assert.equal(Math.max(...sizes), 120, `batches: ${sizes}`);
	assert.ok(Math.max(...sizes) <= 500, `largest batch ${Math.max(...sizes)}`);
	assert.equal(inventory(sqlite).contacts, 120);
});

test("batches are bounded by statements and by bytes", async () => {
	const sqlite = database();
	for (let index = 0; index < 1100; index += 1) sqlite.prepare("INSERT INTO contacts (id, user_id, email, created_at) VALUES (?, 'u1', ?, 1)").run(`c${index}`, `c${index}@example.test`);
	for (let index = 0; index < 6; index += 1) sqlite.prepare("INSERT INTO messages (id, user_id, direction, from_addr, to_addr, text_body, created_at) VALUES (?, 'u1', 'inbound', 'a@example.test', 'b@example.test', ?, 1)").run(`m${index}`, "x".repeat(1_500_000));
	const document = await exported(sqlite);
	const target = d1(sqlite);
	const sizes = [];
	const batch = target.batch;
	const messagesPerBatch = [];
	target.batch = (statements) => {
		sizes.push(statements.length);
		messagesPerBatch.push(statements.filter((statement) => statement.sql.startsWith("INSERT INTO messages")).length);
		return batch(statements);
	};
	await restoreDatabaseRecords(target, encode(document), { bucket: memoryBucket() });
	assert.ok(Math.max(...sizes) <= 500, `largest batch ${Math.max(...sizes)}`);
	// 6 messages of 1.5 MB cannot share one 4 MiB batch: at most 2 per batch.
	assert.ok(Math.max(...messagesPerBatch) <= 2, `messages per batch: ${messagesPerBatch}`);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM messages").get().n, 6);
	assert.equal(inventory(sqlite).contacts, 1100);
});

test("the safety backup is streamed, not built in memory", async () => {
	const sqlite = database();
	for (let index = 0; index < 12; index += 1) sqlite.prepare("INSERT INTO messages (id, user_id, direction, from_addr, to_addr, text_body, created_at) VALUES (?, 'u1', 'inbound', 'a@example.test', 'b@example.test', ?, 1)").run(`m${index}`, "x".repeat(1_000_000));
	const document = await exported(sqlite);
	const bucket = memoryBucket();
	const result = await restoreDatabaseRecords(d1(sqlite), encode(document), { bucket });
	assert.deepEqual(bucket.multipart, [result.safetyBackupKey], "a 12 MB safety backup goes up as a multipart upload");
	assert.equal(bucket.puts.length, 0);
	const safety = JSON.parse(new TextDecoder().decode(await (await bucket.get(result.safetyBackupKey)).arrayBuffer()));
	assert.equal(safety.tables.messages.length, 12);
	assert.equal(bucket.objects.get(result.safetyBackupKey).options.customMetadata.kind, "pre-restore");
});

/** Counts D1 queries the way the platform does: every statement run or read is one, a batch is one. */
function countingD1(sqlite) {
	const target = d1(sqlite);
	const counter = { queries: 0, inBatch: false };
	const prepare = target.prepare;
	target.prepare = (sql) => {
		const statement = prepare(sql);
		for (const method of ["all", "run", "first"]) {
			const original = statement[method];
			statement[method] = (...args) => { if (!counter.inBatch) counter.queries += 1; return original(...args); };
		}
		return statement;
	};
	const batch = target.batch;
	target.batch = async (statements) => {
		counter.queries += 1;
		counter.inBatch = true;
		try { return await batch(statements); } finally { counter.inBatch = false; }
	};
	return { target, counter };
}

test("on D1 the query budget is checked before anything is touched", async () => {
	const sqlite = database();
	for (let index = 0; index < 300; index += 1) sqlite.prepare("INSERT INTO contacts (id, user_id, email, created_at) VALUES (?, 'u1', ?, 1)").run(`c${index}`, `c${index}@example.test`);
	const document = await exported(sqlite);
	const before = inventory(sqlite);
	// Real cost of the same restore without a limit.
	const free = countingD1(sqlite);
	await restoreDatabaseRecords(free.target, encode(document), { bucket: memoryBucket() });
	const actual = free.counter.queries;
	assert.ok(actual > 100, `actual ${actual}`);
	// Refused: nothing deleted, no safety file, and the stated estimate covers the real cost.
	const bucket = memoryBucket();
	const refusing = countingD1(sqlite);
	let message = "";
	await assert.rejects(restoreDatabaseRecords(refusing.target, encode(document), { bucket, maxQueries: actual - 1 }), (error) => { message = error.message; return /queries/.test(error.message) && /Nothing was changed/.test(error.message); });
	assert.deepEqual(inventory(sqlite), before);
	assert.equal(bucket.puts.length + bucket.multipart.length, 0);
	const estimate = Number(/about (\d+) database queries/.exec(message)?.[1]);
	assert.ok(estimate >= actual && estimate <= actual * 2, `estimate ${estimate}, actual ${actual}`);
	assert.ok(refusing.counter.queries <= 20, `the check itself used ${refusing.counter.queries} queries`);
	// Within budget: restores.
	await restoreDatabaseRecords(d1(sqlite), encode(document), { bucket: memoryBucket(), maxQueries: estimate });
});

test("a valid restore still replaces the data", async () => {
	const sqlite = database();
	const document = await exported(sqlite);
	sqlite.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d2', 'u1', 'extra.test', 'z', 1)").run();
	await restoreDatabaseRecords(d1(sqlite), encode(document), { bucket: memoryBucket() });
	assert.deepEqual(sqlite.prepare("SELECT id FROM domains").all().map((row) => row.id), ["d1"]);
});
