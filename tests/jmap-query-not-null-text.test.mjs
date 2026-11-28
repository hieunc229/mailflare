import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "node_modules", "mailflare-jmap-not-null-"));
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
		sourcefile: "jmap-not-null-entry.ts",
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


async function setup(t) {
	const ctx = await fixture(t, [{ id: "m_null", at: 10 }, { id: "m_boss", at: 20 }, { id: "m_other", at: 30 }]);
	ctx.env.DB.db.exec(`
		UPDATE messages SET cc_addr = 'boss@x.com', subject = 'Plan', text_body = 'budget' WHERE id = 'm_boss';
		UPDATE messages SET cc_addr = 'ann@x.com' WHERE id = 'm_other';
	`);
	return ctx;
}
const ids = async (ctx, filter) => (await query(ctx, { filter })).ids.sort();
const not = (c) => ({ operator: "NOT", conditions: [c] });

test("NOT cc keeps messages without a cc", async (t) => {
	assert.deepEqual(await ids(await setup(t), not({ cc: "boss" })), ["m_null", "m_other"]);
});
test("NOT bcc keeps messages without a bcc", async (t) => {
	assert.deepEqual(await ids(await setup(t), not({ bcc: "boss" })), ["m_boss", "m_null", "m_other"]);
});
test("NOT subject keeps messages without a subject", async (t) => {
	assert.deepEqual(await ids(await setup(t), not({ subject: "Plan" })), ["m_null", "m_other"]);
});
test("NOT body keeps messages without a body", async (t) => {
	assert.deepEqual(await ids(await setup(t), not({ body: "budget" })), ["m_null", "m_other"]);
});
test("NOT text keeps messages without any text", async (t) => {
	assert.deepEqual(await ids(await setup(t), not({ text: "budget" })), ["m_null", "m_other"]);
});
test("cc still matches only rows that contain it", async (t) => {
	assert.deepEqual(await ids(await setup(t), { cc: "boss" }), ["m_boss"]);
});
