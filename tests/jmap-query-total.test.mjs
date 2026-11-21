import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "node_modules", "mailflare-jmap-query-total-"));
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
		sourcefile: "jmap-query-total-entry.ts",
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
	database.db.transaction(() => {
		for (const row of rows) insert.run(row.id, row.from ?? "a@one.test", row.subject ?? null, row.at ?? 2);
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

// Ten thousand rows was the old materialisation bound.
const MANY = 10_050;
const manyRows = () => Array.from({ length: MANY }, (_, i) => ({ id: `m_${String(i).padStart(6, "0")}`, at: 100 + i }));

test("total and paging reach past 10,000 messages", async (t) => {
	const ctx = await fixture(t, manyRows());
	const res = await query(ctx, { position: 10_000, limit: 50, calculateTotal: true });
	assert.equal(res.total, MANY);
	assert.equal(res.position, 10_000);
	assert.equal(res.ids.length, 50);
	// Newest first, so position 10,000 is the 10,001st newest message.
	assert.equal(res.ids[0], `m_${String(MANY - 1 - 10_000).padStart(6, "0")}`);
});

test("a negative position counts back from the real end", async (t) => {
	const ctx = await fixture(t, manyRows());
	const res = await query(ctx, { position: -2, calculateTotal: true });
	assert.equal(res.position, MANY - 2);
	assert.deepEqual(res.ids, ["m_000001", "m_000000"]);
});

test("a position past the end returns no ids", async (t) => {
	const ctx = await fixture(t, [{ id: "m_a" }, { id: "m_b" }]);
	const res = await query(ctx, { position: 5, calculateTotal: true });
	assert.equal(res.total, 2);
	assert.deepEqual(res.ids, []);
});

test("collapseThreads counts one per thread", async (t) => {
	const ctx = await fixture(t, [{ id: "m_a", at: 1 }, { id: "m_b", at: 2 }, { id: "m_c", at: 3 }]);
	ctx.env.DB.db.exec(`UPDATE messages SET thread_id = 't1' WHERE id IN ('m_a', 'm_b')`);
	const res = await query(ctx, { collapseThreads: true, calculateTotal: true });
	assert.equal(res.total, 2);
	assert.deepEqual(res.ids, ["m_c", "m_b"]);
});

test("anchors still resolve", async (t) => {
	const ctx = await fixture(t, ["a", "b", "c"].map((subject, i) => ({ id: `m_${subject}`, subject, at: 10 + i })));
	const res = await query(ctx, { anchor: "m_b", anchorOffset: 1, calculateTotal: true });
	assert.equal(res.position, 2);
	assert.equal(res.total, 3);
	assert.deepEqual(res.ids, ["m_a"]);
});
