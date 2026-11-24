import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-promotions-api-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
// Only the session lookup is replaced; routes run against a real in-memory SQLite database.
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export * as list from "./src/app/api/messages/route.ts";
			export * as counts from "./src/app/api/messages/counts/route.ts";
		`,
		resolveDir: root,
		sourcefile: "promotions-api-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "next/headers": "next/headers.js", "next/server": "next/server.js", "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	plugins: [{
		name: "session",
		setup(builder) {
			builder.onResolve({ filter: /^@\/lib\/auth\/cookies$/ }, (args) => ({ path: args.path, namespace: "mock" }));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: "export async function getCurrentUser(){return globalThis.__testUser}", loader: "js" }));
		},
	}],
	logLevel: "silent",
});
const m = await import(pathToFileURL(join(directory, "entry.mjs")).href);

async function fixture(t, modes) {
	const database = new m.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await m.applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('u', 'o@one.test', 'h', 'O', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d', 'u', 'one.test', 'z', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('a', 'u', 'd', 'a', 1), ('b', 'u', 'd', 'b', 1);
	`);
	for (const [mailbox, mode] of Object.entries(modes)) database.db.prepare("INSERT INTO mailbox_promotion_settings (mailbox_id, mode, updated_at) VALUES (?, ?, 1)").run(mailbox, mode);
	const insert = database.db.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, category, read, created_at) VALUES (?, 'u', ?, 'inbound', 'x@x.test', 'o@one.test', 'received', ?, ?, ?)");
	insert.run("a-promo", "a", "promotions", 0, 1);
	insert.run("a-promo-read", "a", "promotions", 1, 2);
	insert.run("a-plain", "a", null, 0, 3);
	insert.run("b-promo", "b", "promotions", 0, 4);
	insert.run("b-plain", "b", null, 0, 5);
	const env = { DB: database, MAILFLARE_RUNTIME: "node" };
	globalThis.__mailflareNodeEnv = env;
	globalThis.__testUser = { id: "u", role: "admin", email: "o@one.test", timeZone: "UTC" };
	t.after(() => { delete globalThis.__mailflareNodeEnv; delete globalThis.__testUser; });
}

const list = async (query) => {
	const response = await m.list.GET(new Request(`https://mail.test/api/messages?${query}`));
	return { status: response.status, body: await response.json() };
};
const ids = (result) => result.body.messages.map((row) => row.id).sort();
const INBOX = "direction=inbound&status=received";

test("with every mode off, Inbox lists everything and counts have no promotions", async (t) => {
	await fixture(t, {});
	assert.deepEqual(ids(await list(INBOX)), ["a-plain", "a-promo", "a-promo-read", "b-plain", "b-promo"]);
	const { counts } = await (await m.counts.GET(new Request("https://mail.test/api/messages/counts"))).json();
	assert.deepEqual(counts.folders.promotions, { total: 0, unread: 0 });
	assert.deepEqual(counts.folders.inbox, { total: 5, unread: 4 });
});

test("category=promotions lists only promotions of mailboxes that turned it on, and needs status=received", async (t) => {
	await fixture(t, { a: "show", b: "show" });
	assert.deepEqual(ids(await list(`${INBOX}&category=promotions`)), ["a-promo", "a-promo-read", "b-promo"]);
	assert.deepEqual(ids(await list(`${INBOX}&category=promotions&mailboxId=b`)), ["b-promo"]);
	assert.equal((await list("direction=inbound&category=promotions")).status, 400);
	assert.equal((await list(`${INBOX}&category=social`)).status, 400);
	assert.equal((await list(`${INBOX}&category=promotions&folderId=f`)).status, 400);
});

test("category=promotions is empty for mailboxes whose mode is off", async (t) => {
	await fixture(t, { b: "show" });
	assert.deepEqual(ids(await list(`${INBOX}&category=promotions`)), ["b-promo"]);
	assert.deepEqual(ids(await list(`${INBOX}&category=promotions&mailboxId=a`)), []);
});

test("a separate mailbox hides promotions from Inbox; show and off mailboxes do not", async (t) => {
	await fixture(t, { a: "separate", b: "show" });
	assert.deepEqual(ids(await list(INBOX)), ["a-plain", "b-plain", "b-promo"]);
	assert.deepEqual(ids(await list(`${INBOX}&mailboxId=a`)), ["a-plain"]);
	assert.deepEqual(ids(await list(`${INBOX}&mailboxId=b`)), ["b-plain", "b-promo"]);
	// The promotions list and search still see them.
	assert.deepEqual(ids(await list(`${INBOX}&category=promotions&mailboxId=a`)), ["a-promo", "a-promo-read"]);
});

test("counts: promotions fill for opted-in mailboxes, and separate ones leave Inbox", async (t) => {
	await fixture(t, { a: "separate", b: "show" });
	const { counts } = await (await m.counts.GET(new Request("https://mail.test/api/messages/counts"))).json();
	assert.deepEqual(counts.folders.promotions, { total: 3, unread: 2 });
	assert.deepEqual(counts.folders.inbox, { total: 5 - 2, unread: 4 - 1 });
	assert.equal(counts.mailboxes.find((box) => box.mailboxId === "a").inbox, 1);
	assert.equal(counts.mailboxes.find((box) => box.mailboxId === "b").inbox, 2);
});

test("the promotions count is answered from a covering index", async (t) => {
	await fixture(t, { a: "show" });
	const database = globalThis.__mailflareNodeEnv.DB;
	const captured = [];
	const prepare = database.prepare.bind(database);
	database.prepare = (sql) => {
		const statement = prepare(sql);
		const bind = statement.bind.bind(statement);
		statement.bind = (...values) => {
			if (/"category"/.test(sql) && /count\(/.test(sql)) captured.push({ sql, values });
			return bind(...values);
		};
		return statement;
	};
	await m.counts.GET(new Request("https://mail.test/api/messages/counts"));
	assert.equal(captured.length, 1);
	const plan = database.db.prepare(`EXPLAIN QUERY PLAN ${captured[0].sql}`).all(...captured[0].values).map((row) => row.detail).join("\n");
	assert.match(plan, /USING COVERING INDEX messages_category_count_idx/);
});

test("a row marked primary (manual Move to Inbox) behaves like uncategorised: in Inbox, not in Promotions, counted in Inbox", async (t) => {
	await fixture(t, { a: "separate" });
	globalThis.__mailflareNodeEnv.DB.db.prepare("UPDATE messages SET category = 'primary' WHERE id = 'a-promo'").run();
	assert.deepEqual(ids(await list(`${INBOX}&mailboxId=a`)), ["a-plain", "a-promo"]);
	assert.deepEqual(ids(await list(`${INBOX}&category=promotions&mailboxId=a`)), ["a-promo-read"]);
	const { counts } = await (await m.counts.GET(new Request("https://mail.test/api/messages/counts"))).json();
	assert.equal(counts.mailboxes.find((box) => box.mailboxId === "a").inbox, 2);
	assert.deepEqual(counts.folders.promotions, { total: 1, unread: 0 });
});
