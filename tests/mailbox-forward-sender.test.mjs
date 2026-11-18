import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Mailbox forward rules are decided before the message is parsed. Folder, spam and
// trash rules match the From header, so a forward rule on the same sender field must
// match it as well, not only the envelope sender (often a bounce address).

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-forward-sender-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { resolveInboundAddress, resolveInboxRuleDestination } from "./src/lib/email/routing.ts";
		`,
		resolveDir: root,
		sourcefile: "forward-sender-test-entry.ts",
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
const { SqliteDatabase, applyMigrations, getDb, resolveInboundAddress, resolveInboxRuleDestination } = await import(
	pathToFileURL(join(directory, "entry.mjs")).href
);

const ENVELOPE = "m-1f9u6e691x8cd3@bounce.example-jobs.test";
const HEADER_FROM = '"Job Alerts" <jobalerts-noreply@example-jobs.test>';

async function fixture(t, rule) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at)
			VALUES ('admin', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at)
			VALUES ('one', 'admin', 'one.test', 'zone-one', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at)
			VALUES ('box', 'admin', 'one', 'me', 1);
		INSERT INTO folders (id, user_id, mailbox_id, name, created_at)
			VALUES ('alerts', 'admin', 'box', 'Alerts', 1);
	`);
	database.db.prepare(`
		INSERT INTO routing_rules (id, user_id, domain_id, scope, mailbox_id, folder_id, pattern, match_field, match_operator,
			match_value, action, forward_to, keep_copy, enabled, priority, created_at)
		VALUES (?, 'admin', 'one', 'mailbox', 'box', ?, ?, ?, ?, ?, ?, ?, 0, 1, 10, 1)
	`).run(
		"rule", rule.folderId ?? null, rule.value, rule.field ?? "email", rule.operator ?? "exact",
		rule.value, rule.action ?? "forward", rule.action && rule.action !== "forward" ? null : "elsewhere@other.test",
	);
	const env = { DB: database, MAILFLARE_RUNTIME: "node" };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	return getDb(env);
}

for (const field of ["email", "sender"]) {
	test(`a "${field}" forward rule matches the From header when the envelope sender is a bounce address`, async (t) => {
		const db = await fixture(t, { field, value: "jobalerts-noreply@example-jobs.test" });
		const decision = await resolveInboundAddress(db, "me@one.test", ENVELOPE, {
			mailboxForwards: { subject: "New jobs for you", from: HEADER_FROM },
		});
		assert.equal(decision?.action, "forward");
		assert.equal(decision?.forwardTo, "elsewhere@other.test");
	});
}

test("a forward rule still matches the envelope sender", async (t) => {
	const db = await fixture(t, { value: "bounce.example-jobs.test", operator: "contains" });
	const decision = await resolveInboundAddress(db, "me@one.test", ENVELOPE, {
		mailboxForwards: { subject: "New jobs for you", from: '"Someone" <someone@unrelated.test>' },
	});
	assert.equal(decision?.action, "forward");
});

test("a forward rule does not match when neither sender matches", async (t) => {
	const db = await fixture(t, { value: "jobalerts-noreply@example-jobs.test" });
	const decision = await resolveInboundAddress(db, "me@one.test", ENVELOPE, {
		mailboxForwards: { subject: "Hello", from: '"Someone" <someone@unrelated.test>' },
	});
	assert.equal(decision?.action, "store");
});

test("without a From header the forward rule falls back to the envelope sender only", async (t) => {
	const db = await fixture(t, { value: "jobalerts-noreply@example-jobs.test" });
	const decision = await resolveInboundAddress(db, "me@one.test", ENVELOPE, {
		mailboxForwards: { subject: "New jobs for you" },
	});
	assert.equal(decision?.action, "store");
});

test("the same condition matches for a forward rule and a folder rule", async (t) => {
	const condition = { value: "jobalerts-noreply@example-jobs.test" };
	const forwardDb = await fixture(t, condition);
	const forward = await resolveInboundAddress(forwardDb, "me@one.test", ENVELOPE, {
		mailboxForwards: { subject: "New jobs for you", from: HEADER_FROM },
	});

	const folderDb = await fixture(t, { ...condition, action: "store", folderId: "alerts" });
	const folder = await resolveInboxRuleDestination(folderDb, {
		mailboxId: "box",
		toAddress: "me@one.test",
		fromAddress: HEADER_FROM,
		subject: "New jobs for you",
	});

	assert.equal(forward?.action, "forward");
	assert.equal(folder.folderId, "alerts");
});
