import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "node_modules", "mailflare-jmap-fts-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { messages } from "./src/db/schema/index.ts";
			export { filterToSql } from "./src/lib/jmap/email-query.ts";
			export { getDb } from "./src/db/index.ts";
			export { processRequest } from "./src/lib/jmap/processor.ts";
		`,
		resolveDir: root,
		sourcefile: "jmap-fts-entry.ts",
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
const { SqliteDatabase, applyMigrations, getDb, processRequest, messages, filterToSql } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

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
		`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, bcc_addr, status, read, starred, created_at) VALUES (?, 'admin', '${MAILBOX}', 'inbound', ?, 'support@one.test', ?, ?, ?, 'received', 0, 0, ?)`,
	);
	for (const row of rows) insert.run(row.id, row.from ?? "a@one.test", row.subject ?? null, row.body ?? null, row.bcc ?? null, row.at ?? 2);
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


async function setup(t) {
	return fixture(t, [
		{ id: "m_inv", at: 30, subject: "Invoice March", body: "please pay", from: "billing@acme.test" },
		{ id: "m_body", at: 20, subject: "Hello", body: "the invoice is attached", from: "bob@other.test" },
		{ id: "m_other", at: 10, subject: "Lunch", body: "see you", from: "bob@other.test", bcc: "carol@x.test" },
	]);
}
const ids = async (t, filter) => (await query(await setup(t), { filter })).ids;

test("text prefix matches a word start", async (t) => assert.deepEqual(await ids(t, { text: "inv" }), ["m_inv", "m_body"]));
test("text no longer matches mid-word", async (t) => assert.deepEqual(await ids(t, { text: "voice" }), []));
test("subject filter is column scoped", async (t) => assert.deepEqual(await ids(t, { subject: "inv" }), ["m_inv"]));
test("body filter excludes subject matches", async (t) => assert.deepEqual(await ids(t, { body: "inv" }), ["m_body"]));
test("from filter matches an address word", async (t) => assert.deepEqual(await ids(t, { from: "acme" }), ["m_inv"]));
test("NOT text keeps the other rows", async (t) => assert.deepEqual(await ids(t, { operator: "NOT", conditions: [{ text: "invoice" }] }), ["m_other"]));
test("a leading dash is literal", async (t) => assert.deepEqual(await ids(t, { text: "-invoice" }), ["m_inv", "m_body"]));
test("punctuation only does not error", async (t) => {
	const result = await query(await setup(t), { filter: { text: "!!!" } });
	assert.ok(Array.isArray(result.ids), JSON.stringify(result));
});
test("quotes in the value do not break the query", async (t) => {
	const result = await query(await setup(t), { filter: { text: 'a" OR b* (' } });
	assert.ok(Array.isArray(result.ids), JSON.stringify(result));
});
test("bcc keeps substring semantics", async (t) => assert.deepEqual(await ids(t, { bcc: "arol" }), ["m_other"]));
test("text uses the FTS index", async (t) => {
	const ctx = await setup(t);
	const built = ctx.db.select({ id: messages.id }).from(messages).where(filterToSql({ text: "inv" }, new Set([MAILBOX]), "admin")).toSQL();
	assert.match(built.sql, /messages_fts/);
});
