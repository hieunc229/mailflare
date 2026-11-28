import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-inbound-parallel-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));

// Modules inbound.ts imports are replaced for inbound.ts only: each wraps the real one with a hook the tests control.
const real = (path) => JSON.stringify(join(root, path));
const wrappers = {
	"@/lib/email/routing": `
		import * as real from ${real("src/lib/email/routing.ts")};
		export * from ${real("src/lib/email/routing.ts")};
		export const resolveInboxRuleDestination = (...args) => globalThis.__hooks.destination(() => real.resolveInboxRuleDestination(...args));`,
	"@/lib/email/threading": `
		import * as real from ${real("src/lib/email/threading.ts")};
		export * from ${real("src/lib/email/threading.ts")};
		export const resolveThreadId = (...args) => globalThis.__hooks.thread(() => real.resolveThreadId(...args));`,
	"@/lib/deliverability/suppression": `
		import * as real from ${real("src/lib/deliverability/suppression.ts")};
		export * from ${real("src/lib/deliverability/suppression.ts")};
		export const recordDsnBounces = (...args) => globalThis.__hooks.bounces(() => real.recordDsnBounces(...args));`,
	"@/lib/email/auto-reply": `
		import * as real from ${real("src/lib/email/auto-reply.ts")};
		export * from ${real("src/lib/email/auto-reply.ts")};
		export const sendMailboxAutoReply = (...args) => globalThis.__hooks.autoReply(() => real.sendMailboxAutoReply(...args));`,
	"@/lib/spam/providers/external": `
		export class ExternalSpamIntelligenceProvider { async check() { globalThis.__hooks.lookups += 1; return []; } }`,
};
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { processInboundMessage } from "./src/lib/email/inbound.ts";
		`,
		resolveDir: root,
		sourcefile: "inbound-parallel-entry.ts",
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
	plugins: [{
		name: "inbound-only-wrappers",
		setup(builder) {
			builder.onResolve({ filter: /^@\/lib\/(email\/(routing|threading|auto-reply)|deliverability\/suppression|spam\/providers\/external)$/ }, (args) => (
				args.importer.endsWith("src/lib/email/inbound.ts") ? { path: args.path, namespace: "wrap" } : undefined
			));
			builder.onLoad({ filter: /.*/, namespace: "wrap" }, ({ path }) => ({ loader: "js", contents: wrappers[path], resolveDir: root }));
		},
	}],
});
const m = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const WAIT_MS = 400;
// Resolves true when `other` starts before WAIT_MS passes.
function startedWithin(promise) {
	return Promise.race([promise.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), WAIT_MS))]);
}
function gate() {
	let open;
	const promise = new Promise((resolve) => { open = resolve; });
	return { promise, open };
}

async function fixture(t, { spamRule = false } = {}) {
	const database = new m.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await m.applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('admin', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('one', 'admin', 'one.test', 'zone-one', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('box', 'admin', 'one', 'me', 1);
	`);
	if (spamRule) {
		database.db.exec(`INSERT INTO routing_rules (id, user_id, domain_id, scope, mailbox_id, pattern, match_field, match_operator, match_value, action, keep_copy, enabled, priority, created_at)
			VALUES ('r', 'admin', 'one', 'mailbox', 'box', 'x', 'sender', 'contains', 'friend@x.test', 'spam', 0, 1, 1, 1)`);
	}
	const objects = new Map();
	const env = {
		DB: database,
		MAILFLARE_RUNTIME: "node",
		BUCKET: { get: async (key) => (objects.has(key) ? { arrayBuffer: async () => objects.get(key) } : null), put: async () => {}, delete: async (key) => { objects.delete(key); } },
		REALTIME: { getByName: () => ({ fetch: async () => new Response(null, { status: 204 }) }) },
	};
	globalThis.__mailflareNodeEnv = env;
	globalThis.__hooks = { lookups: 0, destination: (run) => run(), thread: (run) => run(), bounces: (run) => run(), autoReply: (run) => run() };
	const quiet = console.info;
	console.info = () => {};
	t.after(() => { delete globalThis.__mailflareNodeEnv; delete globalThis.__hooks; console.info = quiet; });
	const raw = "From: friend@x.test\r\nTo: me@one.test\r\nSubject: Hello\r\nMessage-ID: <a1@x.test>\r\nDate: Thu, 19 Nov 2026 10:00:00 +0000\r\nContent-Type: text/plain\r\n\r\nhi there\r\n";
	objects.set("raw/1", new TextEncoder().encode(raw).buffer);
	const deliver = () => m.processInboundMessage(env, { from: "friend@x.test", to: "me@one.test", rawR2Key: "raw/1" });
	return { deliver, sqlite: database.db };
}

test("the rule destination, owner and thread reads run together", async (t) => {
	const { deliver } = await fixture(t);
	const threadStarted = gate();
	const destinationStarted = gate();
	let destinationSawThread = null;
	globalThis.__hooks.destination = async (run) => { destinationStarted.open(); destinationSawThread = await startedWithin(threadStarted.promise); return run(); };
	globalThis.__hooks.thread = (run) => { threadStarted.open(); return run(); };
	await deliver();
	assert.equal(destinationSawThread, true, "the thread lookup did not start while the destination read was pending");
});

test("bounce recording and the auto-reply run together", async (t) => {
	const { deliver } = await fixture(t);
	const bouncesStarted = gate();
	const autoReplyStarted = gate();
	let bouncesSawAutoReply = null;
	globalThis.__hooks.bounces = async (run) => { bouncesStarted.open(); bouncesSawAutoReply = await startedWithin(autoReplyStarted.promise); return run(); };
	globalThis.__hooks.autoReply = (run) => { autoReplyStarted.open(); return run(); };
	await deliver();
	assert.equal(bouncesSawAutoReply, true, "the auto-reply did not start while bounce recording was pending");
});

test("mail a mailbox rule files as spam makes no external spam lookups", async (t) => {
	const { deliver, sqlite } = await fixture(t, { spamRule: true });
	await deliver();
	const row = sqlite.prepare("SELECT status, spam_verdict, spam_signals FROM messages WHERE raw_r2_key = 'raw/1'").get();
	assert.equal(row.status, "spam");
	assert.equal(row.spam_verdict, "spam");
	assert.match(row.spam_signals, /mailbox_rule_spam/);
	assert.equal(globalThis.__hooks.lookups, 0);
});

test("ordinary mail still gets external spam lookups", async (t) => {
	const { deliver } = await fixture(t);
	await deliver();
	assert.ok(globalThis.__hooks.lookups > 0);
});
