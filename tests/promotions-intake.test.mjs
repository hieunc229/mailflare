import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-promotions-intake-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { processInboundMessage } from "./src/lib/email/inbound.ts";
		`,
		resolveDir: root,
		sourcefile: "promotions-intake-entry.ts",
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

function mime(from, extraHeaders = "", body = "hi there") {
	return `From: ${from}\r\nTo: me@one.test\r\nSubject: Hello\r\nMessage-ID: <${Math.random().toString(36).slice(2)}@x.test>\r\nDate: Thu, 19 Nov 2026 10:00:00 +0000\r\n${extraHeaders}Content-Type: text/plain\r\n\r\n${body}\r\n`;
}

async function fixture(t) {
	const database = new m.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await m.applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('admin', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('one', 'admin', 'one.test', 'zone-one', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('box', 'admin', 'one', 'me', 1);
	`);
	const objects = new Map();
	const env = {
		DB: database,
		MAILFLARE_RUNTIME: "node",
		BUCKET: { get: async (key) => (objects.has(key) ? { arrayBuffer: async () => objects.get(key) } : null), put: async () => {}, delete: async (key) => { objects.delete(key); } },
	};
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	let n = 0;
	const deliver = async (from, headers = "", payloadHeaders, body) => {
		const key = `raw/${++n}`;
		objects.set(key, new TextEncoder().encode(mime(from, headers, body)).buffer);
		await m.processInboundMessage(env, { from: "bounce@x.test", to: "me@one.test", rawR2Key: key, headers: payloadHeaders });
		return database.db.prepare("SELECT category, sender_address FROM messages WHERE raw_r2_key = ?").get(key);
	};
	// Realtime hub stand-in: every body POSTed to a user's hub, in order.
	const sent = [];
	env.REALTIME = { getByName: (user) => ({ fetch: async (_url, init) => { sent.push({ user, body: JSON.parse(init.body) }); return new Response(null, { status: 204 }); } }) };
	return { deliver, raw: database.db, sent };
}

test("intake stores the category and sender address of bulk mail", async (t) => {
	const { deliver } = await fixture(t);
	const quiet = console.info; console.info = () => {};
	t.after(() => { console.info = quiet; });
	assert.deepEqual(await deliver("News <News@Acme.com>", "List-Unsubscribe: <https://acme.com/u>\r\n"), { category: "promotions", sender_address: "news@acme.com" });
	assert.deepEqual(await deliver("Friend <friend@x.test>"), { category: null, sender_address: "friend@x.test" });
});

test("an ESP receipt with a footer unsubscribe link and no list headers stays in Inbox", async (t) => {
	const { deliver, raw } = await fixture(t);
	const receipt = await deliver("Shop <orders@shop.test>", "X-SES-Outgoing: 2026.11.19-1.2.3.4\r\nX-SG-EID: abc\r\n", undefined, "Your receipt. Unsubscribe: https://shop.test/unsubscribe?u=1");
	assert.equal(receipt.category, null);
	assert.equal(raw.prepare("SELECT has_unsubscribe FROM messages WHERE sender_address = 'orders@shop.test'").get().has_unsubscribe, 1);
});

test("intake reads headers from the raw message when the payload has none, and honours payload headers when present", async (t) => {
	const { deliver } = await fixture(t);
	assert.equal((await deliver("a@acme.com", "Precedence: bulk\r\n", undefined)).category, "promotions");
	assert.equal((await deliver("b@acme.com", "", { "list-unsubscribe": "<https://b.test/u>" })).category, "promotions");
});

test("a sender override and a correspondent contact keep mail in Inbox", async (t) => {
	const { deliver, raw } = await fixture(t);
	raw.exec("INSERT INTO mailbox_sender_preferences (id, mailbox_id, sender_address, category_override, updated_at) VALUES ('p', 'box', 'vip@acme.com', 'inbox', 1)");
	assert.equal((await deliver("vip@acme.com", "List-Unsubscribe: <https://acme.com/u>\r\n")).category, null);
	raw.exec("INSERT INTO contacts (id, user_id, email, source, created_at) VALUES ('c', 'admin', 'pal@acme.com', 'outbound', 1)");
	assert.equal((await deliver("pal@acme.com", "List-Unsubscribe: <https://acme.com/u>\r\n")).category, null);
});

const PROMO = "List-Unsubscribe: <https://acme.com/u>\r\n";

test("a promotion in a separate mailbox is not announced, but open sessions are told to refresh", async (t) => {
	const { deliver, raw, sent } = await fixture(t);
	const quiet = console.info; console.info = () => {};
	t.after(() => { console.info = quiet; });
	raw.exec("INSERT INTO mailbox_promotion_settings (mailbox_id, mode, updated_at) VALUES ('box', 'separate', 1)");
	await deliver("News <n@acme.com>", PROMO);
	assert.deepEqual(sent.map((entry) => [entry.user, entry.body.type, entry.body.changed]), [["admin", "revision", true]]);
	assert.equal(typeof sent[0].body.revision, "string");
	sent.length = 0;
	await deliver("Friend <f@x.test>");
	assert.deepEqual(sent.map((entry) => entry.body.type), ["new_message"]);
	assert.equal("category" in sent[0].body, false);
});

test("a promotion is announced in show mode, in off mode and before the settings table exists, carrying its category", async (t) => {
	const { deliver, raw, sent } = await fixture(t);
	const quiet = console.info; console.info = () => {};
	t.after(() => { console.info = quiet; });
	await deliver("News <n@acme.com>", PROMO);
	raw.exec("INSERT INTO mailbox_promotion_settings (mailbox_id, mode, updated_at) VALUES ('box', 'show', 1)");
	await deliver("News <n@acme.com>", PROMO);
	raw.exec("DROP TABLE mailbox_promotion_settings");
	await deliver("News <n@acme.com>", PROMO);
	assert.deepEqual(sent.map((entry) => [entry.body.type, entry.body.category]), [["new_message", "promotions"], ["new_message", "promotions"], ["new_message", "promotions"]]);
});

test("the message.inbound webhook carries the category", async (t) => {
	const { deliver, raw } = await fixture(t);
	const quiet = console.info; console.info = () => {};
	t.after(() => { console.info = quiet; });
	const error = console.error; console.error = () => {};
	t.after(() => { console.error = error; });
	raw.exec("INSERT INTO webhooks (id, user_id, url, secret, events, enabled, created_at) VALUES ('w', 'admin', 'https://hooks.invalid/x', 's', '[\"message.inbound\"]', 1, 1)");
	await deliver("News <n@acme.com>", PROMO);
	await deliver("Friend <f@x.test>");
	const payloads = raw.prepare("SELECT payload FROM webhook_deliveries ORDER BY rowid").all().map((row) => JSON.parse(row.payload).data);
	assert.deepEqual(payloads.map((data) => data.category), ["promotions", null]);
});
