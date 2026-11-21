import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "node_modules", "mailflare-jmap-thread-keyword-"));
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
		sourcefile: "jmap-thread-keyword-entry.ts",
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

/** Thread t1 has one flagged and one unflagged message, t2 is all flagged, t3 has none flagged. */
async function threads(t) {
	const ctx = await fixture(t, ["m_1a", "m_1b", "m_2a", "m_2b", "m_3a"].map((id, i) => ({ id, at: 10 + i })));
	ctx.env.DB.db.exec(`
		UPDATE messages SET thread_id = 't1' WHERE id IN ('m_1a', 'm_1b');
		UPDATE messages SET thread_id = 't2' WHERE id IN ('m_2a', 'm_2b');
		UPDATE messages SET starred = 1 WHERE id IN ('m_1a', 'm_2a', 'm_2b');
	`);
	return ctx;
}

const ids = async (ctx, filter) => (await query(ctx, { filter, sort: [{ property: "receivedAt", isAscending: false }] })).ids.sort();

test("someInThreadHaveKeyword matches every message of a thread with one flagged message", async (t) => {
	const ctx = await threads(t);
	assert.deepEqual(await ids(ctx, { someInThreadHaveKeyword: "$flagged" }), ["m_1a", "m_1b", "m_2a", "m_2b"]);
});

test("allInThreadHaveKeyword needs every message of the thread flagged", async (t) => {
	const ctx = await threads(t);
	assert.deepEqual(await ids(ctx, { allInThreadHaveKeyword: "$flagged" }), ["m_2a", "m_2b"]);
});

test("noneInThreadHaveKeyword drops a thread with any flagged message", async (t) => {
	const ctx = await threads(t);
	assert.deepEqual(await ids(ctx, { noneInThreadHaveKeyword: "$flagged" }), ["m_3a"]);
});

test("a thread condition combines with a per-message condition", async (t) => {
	const ctx = await threads(t);
	assert.deepEqual(await ids(ctx, { someInThreadHaveKeyword: "$flagged", notKeyword: "$flagged" }), ["m_1b"]);
});
