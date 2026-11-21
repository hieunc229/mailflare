import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "node_modules", "mailflare-jmap-query-rfc-"));
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
		sourcefile: "jmap-query-rfc-entry.ts",
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
		`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, read, starred, created_at) VALUES (?, 'admin', '${MAILBOX}', 'inbound', ?, 'support@one.test', ?, 'received', 0, 0, ?)`,
	);
	for (const row of rows) insert.run(row.id, row.from ?? "a@one.test", row.subject ?? null, row.at ?? 2);
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

test("a comparator without isAscending sorts ascending", async (t) => {
	const ctx = await fixture(t, [{ id: "m_b", subject: "Bravo" }, { id: "m_a", subject: "Alpha" }, { id: "m_c", subject: "Charlie" }]);
	assert.deepEqual((await query(ctx, { sort: [{ property: "subject" }] })).ids, ["m_a", "m_b", "m_c"]);
	assert.deepEqual((await query(ctx, { sort: [{ property: "subject", isAscending: false }] })).ids, ["m_c", "m_b", "m_a"]);
});

test("no sort still lists the newest message first", async (t) => {
	const ctx = await fixture(t, [{ id: "m_old", at: 10 }, { id: "m_new", at: 20 }]);
	assert.deepEqual((await query(ctx, {})).ids, ["m_new", "m_old"]);
});

test("NOT matches only messages that match none of its conditions", async (t) => {
	const ctx = await fixture(t, [
		{ id: "m_x", from: "x@one.test", subject: "hello" },
		{ id: "m_y", from: "y@one.test", subject: "other" },
		{ id: "m_z", from: "z@one.test", subject: "zzz" },
	]);
	const res = await query(ctx, { filter: { operator: "NOT", conditions: [{ from: "x@" }, { subject: "other" }] }, sort: [{ property: "subject", isAscending: true }] });
	assert.deepEqual(res.ids, ["m_z"]);
});

test("an anchorOffset before the first message clamps to position 0", async (t) => {
	const ctx = await fixture(t, ["a", "b", "c", "d", "e"].map((subject, i) => ({ id: `m_${subject}`, subject, at: 10 + i })));
	const res = await query(ctx, { sort: [{ property: "subject", isAscending: true }], anchor: "m_b", anchorOffset: -3, limit: 2 });
	assert.equal(res.position, 0);
	assert.deepEqual(res.ids, ["m_a", "m_b"]);
});

test("a negative position still counts back from the end", async (t) => {
	const ctx = await fixture(t, ["a", "b", "c"].map((subject, i) => ({ id: `m_${subject}`, subject, at: 10 + i })));
	const res = await query(ctx, { sort: [{ property: "subject", isAscending: true }], position: -1 });
	assert.equal(res.position, 2);
	assert.deepEqual(res.ids, ["m_c"]);
});
