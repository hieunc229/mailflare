import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "node_modules", "mailflare-jmap-other-than-"));
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
		sourcefile: "jmap-other-than-entry.ts",
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

const FOLDER = `${MAILBOX}~f~fld_work`;

/** m_inbox stays unfiled, m_work is moved into the "Work" folder. */
async function withFolder(t) {
	const ctx = await fixture(t, [{ id: "m_inbox", at: 10 }, { id: "m_work", at: 20 }]);
	ctx.env.DB.db.exec(`
		INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld_work', 'admin', '${MAILBOX}', 'Work', 1);
		UPDATE messages SET folder_id = 'fld_work' WHERE id = 'm_work';
	`);
	return ctx;
}

test("inMailboxOtherThan a folder keeps the mailbox's unfiled messages", async (t) => {
	const ctx = await withFolder(t);
	assert.deepEqual((await query(ctx, { filter: { inMailboxOtherThan: [FOLDER] } })).ids, ["m_inbox"]);
});

test("NOT inMailbox a folder keeps the mailbox's unfiled messages", async (t) => {
	const ctx = await withFolder(t);
	assert.deepEqual((await query(ctx, { filter: { operator: "NOT", conditions: [{ inMailbox: FOLDER }] } })).ids, ["m_inbox"]);
});

test("inMailbox a folder still matches only that folder", async (t) => {
	const ctx = await withFolder(t);
	assert.deepEqual((await query(ctx, { filter: { inMailbox: FOLDER } })).ids, ["m_work"]);
});
