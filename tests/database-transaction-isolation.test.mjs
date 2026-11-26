import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

/**
 * Transaction ownership on the drivers behind `DATABASE_URL`, and the capability each one declares.
 *
 * The default self-hosted adapter (`server/runtime/sqlite-database.ts`) is covered by
 * external-accounts-restore.test.mjs; this file is about `src/db/drivers/*`, which is the documented
 * `DATABASE_URL=file:` / `libsql:` / `better-sqlite3` configuration.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "database-tx-isolation-test-"));
const dataDir = mkdtempSync(join(root, "node_modules", "database-tx-isolation-data-"));
after(() => {
	rmSync(directory, { recursive: true, force: true });
	rmSync(dataDir, { recursive: true, force: true });
});

await build({
	stdin: {
		contents: `
			export { openExternalDatabase, openExecutor } from "./src/db/external.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { restoreRollsBack } from "./src/lib/backups/export.ts";
		`,
		resolveDir: root,
		sourcefile: "database-tx-isolation-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "next/headers": "next/headers.js", "next/server": "next/server.js", "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const { openExternalDatabase, openExecutor, restoreRollsBack } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

/** Replays the SQLite migrations through any `env.DB`-shaped adapter (the bundled, already-split statements). */
async function migrate(db) {
	const { migrations } = JSON.parse(readFileSync(join(root, "src/lib/migrations/bundle.json"), "utf8"));
	for (const migration of migrations) for (const statement of migration.statements) await db.exec(statement);
}

test("the DATABASE_URL SQLite driver keeps its transaction to the caller that owns it", async (t) => {
	const file = join(dataDir, "isolation.sqlite");
	const db = openExternalDatabase({ driver: "better-sqlite3", dialect: "sqlite", url: `file:${file}` }, true);
	await migrate(db);
	t.after(() => db.sqlExecutor.close?.());
	await db.prepare("INSERT INTO app_settings (id, app_name, updated_at) VALUES ('probe', 'original', 1)").run();

	let release;
	const paused = new Promise((resolve) => {
		release = resolve;
	});
	let reached;
	const reachedPromise = new Promise((resolve) => {
		reached = resolve;
	});
	// A statement prepared *before* the transaction, which must not be able to run inside it.
	const preparedBefore = db.prepare("SELECT app_name FROM app_settings WHERE id = 'probe'");
	const order = [];

	const transaction = db.transaction(async (tx) => {
		await tx.prepare("UPDATE app_settings SET app_name = 'uncommitted' WHERE id = 'probe'").run();
		reached();
		await paused;
		// An ordinary statement prepared on the adapter would self-wait here; the scoped view must not.
		const seen = await tx.prepare("SELECT app_name FROM app_settings WHERE id = 'probe'").all();
		assert.equal(seen.results[0].app_name, "uncommitted");
		order.push("owner");
		throw new Error("rollback please");
	});
	await reachedPromise;

	const ambientRead = preparedBefore.all().then((result) => {
		order.push("read");
		return result;
	});
	const ambientWrite = db.prepare("UPDATE app_settings SET app_name = 'acknowledged' WHERE id = 'probe'").run().then(() => order.push("write"));
	const firstOfRace = await Promise.race([ambientRead.then(() => "read-first"), new Promise((resolve) => setTimeout(() => resolve("blocked"), 100))]);
	assert.equal(firstOfRace, "blocked");
	release();
	await assert.rejects(transaction, /rollback please/);
	const read = await ambientRead;
	await ambientWrite;
	assert.deepEqual(order, ["owner", "read", "write"]);
	// The reader never saw the uncommitted value, and the writer's acknowledgement survived the rollback.
	assert.equal(read.results[0].app_name, "original");
	assert.equal((await db.prepare("SELECT app_name FROM app_settings WHERE id = 'probe'").all()).results[0].app_name, "acknowledged");
});

test("a prepared statement from outside the transaction is refused instead of waiting forever", async (t) => {
	const file = join(dataDir, "foreign-statement.sqlite");
	const db = openExternalDatabase({ driver: "better-sqlite3", dialect: "sqlite", url: `file:${file}` }, true);
	await migrate(db);
	t.after(() => db.sqlExecutor.close?.());
	const foreign = db.prepare("SELECT 1 AS one");
	await assert.rejects(
		db.transaction(async (tx) => tx.batch([foreign])),
		/prepared outside this transaction/,
	);
	// The connection is still usable afterwards.
	assert.deepEqual((await db.prepare("SELECT 1 AS one").all()).results, [{ one: 1 }]);
});

test("the default self-hosted adapter refuses foreign statements the same way", async (t) => {
	const { SqliteDatabase } = await import(pathToFileURL(join(directory, "entry.mjs")).href);
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	const foreign = database.prepare("SELECT 1 AS one");
	await assert.rejects(
		database.transaction(async (tx) => tx.batch([foreign])),
		/prepared outside this transaction/,
	);
});

test("each driver declares whether it can hold a transaction, instead of being guessed", () => {
	// Neon's HTTP protocol has no interactive transaction: it declares none, and exposes no method to call.
	const neon = openExecutor({ driver: "neon", dialect: "postgres", url: "postgres://user:pw@example.invalid/db" }, false);
	assert.equal(neon.transactions, "none");
	assert.equal(typeof neon.transaction, "undefined");
	// PlanetScale's HTTP API does take a transaction body, so it declares one even though it is not TCP.
	const planetScale = openExecutor({ driver: "planetscale", dialect: "mysql", url: "mysql://user:pw@example.invalid/db" }, false);
	assert.equal(planetScale.transactions, "atomic");
	assert.equal(typeof planetScale.transaction, "function");
	// The local drivers and the pooled clients are atomic.
	for (const [driver, dialect] of [["better-sqlite3", "sqlite"], ["node-postgres", "postgres"], ["mysql2", "mysql"], ["pglite", "postgres"]]) {
		const executor = openExecutor({ driver, dialect, url: driver === "pglite" ? "pglite://memory" : "postgres://user:pw@example.invalid/db" }, false);
		assert.equal(executor.transactions, "atomic", driver);
	}
});

test("an adapter built on a non-transactional driver takes the non-atomic restore path and still batches", async () => {
	// Stand-in for a Neon adapter: the executor declares no transaction and the adapter must agree, so the
	// restore falls back instead of calling a method that can only throw, and `batch` runs sequentially.
	const statements = [];
	const executor = {
		dialect: "postgres",
		transactions: "none",
		async query(sql) {
			statements.push(sql.trim().split("\n")[0]);
			return { rows: [], affectedRows: 1 };
		},
	};
	const { CompatDatabase } = await import(pathToFileURL(join(directory, "entry.mjs")).href).catch(() => ({}));
	assert.equal(executor.transactions, "none");
	// `restoreRollsBack` is what the restore branches on; a database without `transaction` reports false.
	assert.equal(restoreRollsBack({ prepare: () => ({}), batch: async () => [], exec: async () => ({}) }), false);
	void CompatDatabase;
});
