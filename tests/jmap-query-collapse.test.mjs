import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "node_modules", "mailflare-jmap-collapse-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { processRequest } from "./src/lib/jmap/processor.ts";
		`,
		resolveDir: root,
		sourcefile: "jmap-collapse-entry.ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "next/headers": "next/headers.js", "next/server": "next/server.js", "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, getDb, processRequest } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const MAILBOX = "mbx_test";

/** An admin with one mailbox holding the given inbound messages. */
async function fixture(t, rows) {
	const database = new SqliteDatabase(":memory:");
	await applyMigrations(database, join(root, "drizzle/migrations"));
	t.after(() => database.db.close());
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('admin', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('one', 'admin', 'one.test', 'zone-one', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, display_name, use_all_domains, type, disabled, created_at) VALUES ('${MAILBOX}', 'admin', 'one', 'support', 'Support', 1, 'personal', 0, 1);
	`);
	const insert = database.db.prepare(
		`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, read, starred, thread_id, created_at) VALUES (?, 'admin', '${MAILBOX}', 'inbound', ?, 'support@one.test', ?, 'received', 0, 0, ?, ?)`,
	);
	database.db.transaction(() => {
		for (const row of rows) insert.run(row.id, row.from ?? "a@one.test", row.subject ?? null, row.thread ?? null, row.at ?? 2);
	})();
	const env = { DB: database };
	return {
		env,
		db: getDb(env),
		auth: { userId: "admin", email: "owner@one.test", scopes: ["jmap"], mailboxIds: null, user: { id: "admin", email: "owner@one.test", role: "admin" } },
		accountId: "admin",
		origin: "http://test",
		createdIds: {},
	};
}

async function query(ctx, args) {
	const res = await processRequest(ctx, { using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls: [["Email/query", { accountId: "admin", ...args }, "q"]] });
	return res.methodResponses[0][1];
}

const four = [{ id: "m1", thread: "t1", at: 10 }, { id: "m2", thread: "t1", at: 30 }, { id: "m3", thread: "t2", at: 20 }, { id: "m4", thread: null, at: 5 }];
const run = async (t, args, rows = four) => query(await fixture(t, rows), args);

test("collapseThreads keeps the first message of each thread", async (t) => {
	const res = await run(t, { collapseThreads: true, calculateTotal: true });
	assert.deepEqual(res.ids, ["m2", "m3", "m4"]);
	assert.equal(res.total, 3);
});

test("collapsed paging", async (t) => {
	assert.deepEqual((await run(t, { collapseThreads: true, limit: 2, position: 1 })).ids, ["m3", "m4"]);
});

test("negative position counts from the end of the collapsed set", async (t) => {
	const res = await run(t, { collapseThreads: true, position: -1, calculateTotal: true });
	assert.deepEqual(res.ids, ["m4"]);
	assert.equal(res.position, 2);
	assert.equal(res.total, 3);
});

test("anchor sets the position", async (t) => {
	const res = await run(t, { anchor: "m3" });
	assert.equal(res.position, 1);
	assert.deepEqual(res.ids, ["m3", "m1", "m4"]);
	assert.equal((await run(t, { anchor: "m3", anchorOffset: -1 })).position, 0);
	assert.equal((await run(t, { anchor: "m3", anchorOffset: -9 })).position, 0);
});

test("anchor missing or hidden by collapse", async (t) => {
	assert.equal((await run(t, { anchor: "nope" })).type, "anchorNotFound");
	assert.equal((await run(t, { collapseThreads: true, anchor: "m1" })).type, "anchorNotFound");
	assert.equal((await run(t, { collapseThreads: true, anchor: "m3" })).position, 1);
});

test("pages past 10 000 rows are reachable", async (t) => {
	const rows = Array.from({ length: 10_020 }, (_, i) => ({ id: `x${i}`, thread: `tx${i}`, at: 100 + i }));
	const res = await run(t, { collapseThreads: true, position: 10_010, limit: 3 }, rows);
	assert.equal(res.ids.length, 3);
});
