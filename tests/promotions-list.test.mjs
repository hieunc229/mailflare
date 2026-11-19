import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-promotions-list-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { messages } from "./src/db/schema/index.ts";
			export { loadPromotionModes, inboxVisibleCondition } from "./src/lib/promotions/settings.ts";
		`,
		resolveDir: root,
		sourcefile: "promotions-list-entry.ts",
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
const m = await import(pathToFileURL(join(directory, "entry.mjs")).href);

async function fixture(t, { migrate = true } = {}) {
	const database = new m.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	if (migrate) await m.applyMigrations(database, join(root, "drizzle/migrations"));
	else database.db.exec("CREATE TABLE unrelated (id text)");
	if (migrate) database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('u', 'o@one.test', 'h', 'O', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d', 'u', 'one.test', 'z', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('a', 'u', 'd', 'a', 1), ('b', 'u', 'd', 'b', 1), ('c', 'u', 'd', 'c', 1);
		INSERT INTO mailbox_promotion_settings (mailbox_id, mode, updated_at) VALUES ('a', 'separate', 1), ('b', 'show', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, category, created_at) VALUES
			('a-promo', 'u', 'a', 'inbound', 'x@x.test', 'a@one.test', 'received', 'promotions', 1),
			('a-plain', 'u', 'a', 'inbound', 'y@x.test', 'a@one.test', 'received', NULL, 2),
			('b-promo', 'u', 'b', 'inbound', 'x@x.test', 'b@one.test', 'received', 'promotions', 3),
			('c-promo', 'u', 'c', 'inbound', 'x@x.test', 'c@one.test', 'received', 'promotions', 4);
	`);
	const env = { DB: database, MAILFLARE_RUNTIME: "node" };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	return m.getDb(env);
}

test("loadPromotionModes returns only mailboxes with a row; a missing row is off", async (t) => {
	const db = await fixture(t);
	const modes = await m.loadPromotionModes(db, ["a", "b", "c"]);
	assert.deepEqual([...modes].sort(), [["a", "separate"], ["b", "show"]]);
	assert.equal((await m.loadPromotionModes(db, [])).size, 0);
});

test("before the migration every mailbox is off", async (t) => {
	const db = await fixture(t, { migrate: false });
	assert.equal((await m.loadPromotionModes(db, ["a"])).size, 0);
});

test("the Inbox hides promotions only in separate mailboxes", async (t) => {
	const db = await fixture(t);
	const ids = async (condition) => (await db.select({ id: m.messages.id }).from(m.messages).where(condition)).map((row) => row.id).sort();
	assert.equal(m.inboxVisibleCondition([], ["a", "b", "c"]), undefined);
	assert.deepEqual(await ids(m.inboxVisibleCondition(["a"], ["b", "c"])), ["a-plain", "b-promo", "c-promo"]);
	// Same answer when the larger list is the separate one (binds the others instead).
	assert.deepEqual(await ids(m.inboxVisibleCondition(["a", "b"], ["c"])), ["a-plain", "c-promo"]);
	assert.deepEqual(await ids(m.inboxVisibleCondition(["a", "b", "c"], [])), ["a-plain"]);
});

test("the Inbox condition binds the smaller mailbox list, so 60 mailboxes with 50 separate stay under D1's 100 parameters", async (t) => {
	const db = await fixture(t);
	const separate = Array.from({ length: 50 }, (_, i) => `s${i}`);
	const others = Array.from({ length: 10 }, (_, i) => `o${i}`);
	const params = (condition) => db.select({ id: m.messages.id }).from(m.messages).where(condition).toSQL().params.length;
	// The list query also binds the 60 accessible mailbox ids once.
	assert.ok(60 + params(m.inboxVisibleCondition(separate, others)) <= 100);
	assert.ok(60 + params(m.inboxVisibleCondition(others, separate)) <= 100);
});
