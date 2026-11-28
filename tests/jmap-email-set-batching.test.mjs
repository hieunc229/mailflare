import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "node_modules", "mailflare-jmap-set-batch-"));
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
		sourcefile: "jmap-set-batch-entry.ts",
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
	const sqls = [];
	// Statements are cached per SQL text, so record each execution (bind), not each prepare.
	const prepare = database.prepare.bind(database);
	database.prepare = (text) => {
		const statement = prepare(text);
		const bind = statement.bind.bind(statement);
		statement.bind = (...values) => { sqls.push(text); return bind(...values); };
		return statement;
	};
	const env = { DB: database };
	return {
		env,
		db: getDb(env),
		auth: { userId: "admin", email: "owner@one.test", scopes: ["jmap"], mailboxIds: null, user: { id: "admin", email: "owner@one.test", role: "admin" } },
		accountId: "admin",
		origin: "http://test",
		createdIds: {},
		sqls,
	};
}

async function query(ctx, args) {
	const res = await processRequest(ctx, { using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls: [["Email/query", { accountId: "admin", ...args }, "q"]] });
	return res.methodResponses[0][1];
}

const FOLDER = `${MAILBOX}~f~fld_work`;
const OTHER = `${MAILBOX}~f~fld_other`;

async function setup(t) {
	const rows = Array.from({ length: 30 }, (_, i) => ({ id: `m${String(i + 1).padStart(2, "0")}`, at: 10 + i }));
	const ctx = await fixture(t, rows);
	ctx.env.DB.db.exec(`INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld_work', 'admin', '${MAILBOX}', 'Work', 1)`);
	return ctx;
}
async function set(ctx, args) {
	const res = await processRequest(ctx, { using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls: [["Email/set", { accountId: "admin", ...args }, "s"]] });
	return res.methodResponses[0][1];
}
const row = (ctx, id) => ctx.env.DB.db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
const count = (ctx, re) => ctx.sqls.filter((s) => re.test(s)).length;

test("moving 30 messages uses constant queries", async (t) => {
	const ctx = await setup(t);
	const update = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`m${String(i + 1).padStart(2, "0")}`, { mailboxIds: { [FOLDER]: true } }]));
	ctx.sqls.length = 0;
	const res = await set(ctx, { update });
	assert.equal(Object.keys(res.updated).length, 30, JSON.stringify(res));
	assert.equal(ctx.env.DB.db.prepare("SELECT count(*) AS n FROM messages WHERE folder_id = 'fld_work'").get().n, 30);
	assert.ok(count(ctx, /from "folders"/) <= 1, ctx.sqls.join("\n"));
	assert.equal(count(ctx, /^update "messages"/), 1);
	// One load inside Email/set plus the processor's own session-state read afterwards.
	assert.ok(count(ctx, /from "mailboxes" inner join "domains"/) <= 2, String(count(ctx, /from "mailboxes" inner join "domains"/)));
	assert.notEqual(res.newState, res.oldState);
});

test("mixed patches keep their own values", async (t) => {
	const ctx = await setup(t);
	await set(ctx, { update: { m01: { "keywords/$seen": true }, m02: { "keywords/$flagged": true } } });
	assert.deepEqual([row(ctx, "m01").read, row(ctx, "m01").starred], [1, 0]);
	assert.deepEqual([row(ctx, "m02").read, row(ctx, "m02").starred], [0, 1]);
});

test("a foreign folder is rejected for that message only", async (t) => {
	const ctx = await setup(t);
	ctx.env.DB.db.exec(`
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, display_name, use_all_domains, type, disabled, created_at) VALUES ('mbx_two', 'admin', 'one', 'sales', 'Sales', 1, 'personal', 0, 1);
		INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld_other', 'admin', 'mbx_two', 'Other', 1);
	`);
	const res = await set(ctx, { update: { m03: { mailboxIds: { [`mbx_two~f~fld_other`]: true } }, m04: { mailboxIds: { [FOLDER]: true } } } });
	assert.equal(res.notUpdated.m03?.type, "invalidProperties", JSON.stringify(res));
	assert.ok("m04" in res.updated);
	assert.equal(row(ctx, "m04").folder_id, "fld_work");
	assert.equal(row(ctx, "m03").folder_id, null);
});

test("destroy moves to trash in one statement", async (t) => {
	const ctx = await setup(t);
	ctx.sqls.length = 0;
	const res = await set(ctx, { destroy: ["m07", "m05", "m06"] });
	assert.deepEqual(res.destroyed, ["m07", "m05", "m06"]);
	for (const id of res.destroyed) assert.equal(row(ctx, id).status, "trash");
	assert.equal(count(ctx, /^update "messages"/), 1);
});
