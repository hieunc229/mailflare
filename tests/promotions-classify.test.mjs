import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-promotions-classify-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { decideCategory, toSenderAddress } from "./src/lib/promotions/classify-utils.ts";
			export { classifyInboundCategory } from "./src/lib/promotions/classify.ts";
		`,
		resolveDir: root,
		sourcefile: "promotions-classify-entry.ts",
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

const marketing = { bulk: true, kind: "marketing", signals: ["list-unsubscribe"] };
const discussion = { bulk: true, kind: "list", signals: ["list-id"] };
const none = { bulk: false, kind: null, signals: [] };

test("toSenderAddress lower-cases, strips the display name and refuses over-long addresses", () => {
	assert.equal(m.toSenderAddress('"News" <News@Acme.COM>'), "news@acme.com");
	assert.equal(m.toSenderAddress("plain@x.test"), "plain@x.test");
	assert.equal(m.toSenderAddress(""), null);
	assert.equal(m.toSenderAddress(`${"a".repeat(190)}@x.test`), null);
});

test("decideCategory: overrides beat headers, correspondents beat marketing, lists are never promotions", () => {
	assert.equal(m.decideCategory({ verdict: marketing }), "promotions");
	assert.equal(m.decideCategory({ verdict: marketing, override: "inbox" }), null);
	assert.equal(m.decideCategory({ verdict: none, override: "promotions" }), "promotions");
	assert.equal(m.decideCategory({ verdict: marketing, correspondent: true }), null);
	assert.equal(m.decideCategory({ verdict: discussion }), null);
	assert.equal(m.decideCategory({ verdict: none }), null);
});

async function fixture(t, { migrate = true } = {}) {
	const database = new m.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	if (migrate) await m.applyMigrations(database, join(root, "drizzle/migrations"));
	else database.db.exec("CREATE TABLE users (id text)");
	if (migrate) database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('admin', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('one', 'admin', 'one.test', 'zone-one', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('box', 'admin', 'one', 'me', 1);
	`);
	const env = { DB: database, MAILFLARE_RUNTIME: "node" };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	return { db: m.getDb(env), raw: database.db };
}

const NEWS = { "list-unsubscribe": "<https://x.test/u>" };
const base = { mailboxId: "box", from: "News <news@acme.com>", headers: NEWS };

test("classifyInboundCategory files bulk mail from a stranger under promotions with the sender address", async (t) => {
	const { db } = await fixture(t);
	assert.deepEqual(await m.classifyInboundCategory(db, base), { category: "promotions", senderAddress: "news@acme.com" });
	assert.deepEqual(await m.classifyInboundCategory(db, { ...base, headers: { subject: "hi" } }), { category: null, senderAddress: "news@acme.com" });
	assert.deepEqual(await m.classifyInboundCategory(db, { ...base, headers: undefined }), { category: null, senderAddress: "news@acme.com" });
});

test("a manual or outbound contact is never promotions", async (t) => {
	const { db } = await fixture(t);
	assert.equal((await m.classifyInboundCategory(db, { ...base, contactSource: "manual" })).category, null);
	assert.equal((await m.classifyInboundCategory(db, { ...base, contactSource: "outbound" })).category, null);
	assert.equal((await m.classifyInboundCategory(db, { ...base, contactSource: "inbound" })).category, "promotions");
});

test("a stored sender override wins, and only for that mailbox and exact address", async (t) => {
	const { db, raw } = await fixture(t);
	raw.exec(`INSERT INTO mailbox_sender_preferences (id, mailbox_id, sender_address, category_override, updated_at) VALUES ('p1', 'box', 'news@acme.com', 'inbox', 1)`);
	assert.equal((await m.classifyInboundCategory(db, base)).category, null);
	assert.equal((await m.classifyInboundCategory(db, { ...base, from: "othernews@acme.com" })).category, "promotions");
	raw.exec(`UPDATE mailbox_sender_preferences SET category_override = 'promotions'`);
	assert.equal((await m.classifyInboundCategory(db, { ...base, headers: {} })).category, "promotions");
});

test("before the migration, classification falls back to headers only and never throws", async (t) => {
	const { db } = await fixture(t, { migrate: false });
	assert.deepEqual(await m.classifyInboundCategory(db, base), { category: "promotions", senderAddress: "news@acme.com" });
});

test("an unexpected database error classifies as unclassified instead of losing the mail", async () => {
	const broken = { select: () => { throw new Error("boom"); } };
	const quiet = console.error; console.error = () => {};
	try {
		assert.deepEqual(await m.classifyInboundCategory(broken, base), { category: null, senderAddress: "news@acme.com" });
	} finally { console.error = quiet; }
});
