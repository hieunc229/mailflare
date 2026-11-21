import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// A domain rule is resolved while the message is still being received, before its body is
// parsed. The Subject header is therefore the only content field such a rule can match on, and
// the caller has to pass it: without it a "Subject" rule silently never fires.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-domain-rule-subject-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { resolveInboundAddress } from "./src/lib/email/routing.ts";
		`,
		resolveDir: root,
		sourcefile: "domain-rule-subject-entry.ts",
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
const { SqliteDatabase, applyMigrations, getDb, resolveInboundAddress } = await import(
	pathToFileURL(join(directory, "entry.mjs")).href
);

// The recipient is deliberately not a real mailbox, so the domain rules in phase 3 decide.
const TO = "anyone@one.test";
const SUBJECT = "Invoice 4021 for November";

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
			VALUES ('box', 'admin', 'one', 'billing', 1);
	`);
	database.db.prepare(`
		INSERT INTO routing_rules (id, user_id, domain_id, scope, mailbox_id, pattern, match_field, match_operator,
			match_value, action, forward_to, keep_copy, enabled, priority, created_at)
		VALUES ('rule', 'admin', 'one', 'domain', 'box', ?, ?, ?, ?, ?, ?, 0, 1, 10, 1)
	`).run(
		rule.value,
		rule.field,
		rule.operator ?? "contains",
		rule.value,
		rule.action ?? "store",
		rule.action === "forward" ? "elsewhere@other.test" : null,
	);
	const env = { DB: database, MAILFLARE_RUNTIME: "node" };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	return getDb(env);
}

test("a domain rule that matches on the Subject fires when the caller passes the header", async (t) => {
	const db = await fixture(t, { field: "title", value: "invoice" });
	const decision = await resolveInboundAddress(db, TO, "sender@elsewhere.test", { subject: SUBJECT });
	assert.equal(decision?.action, "store");
	assert.equal(decision?.ruleId, "rule");
	assert.equal(decision?.mailbox?.mailboxId, "box");
});

test("a Subject rule fires for reject and forward actions too", async (t) => {
	const reject = await resolveInboundAddress(await fixture(t, { field: "title", value: "invoice", action: "reject" }), TO, "sender@elsewhere.test", { subject: SUBJECT });
	assert.equal(reject?.action, "reject");
	assert.equal(reject?.ruleId, "rule");

	const forward = await resolveInboundAddress(await fixture(t, { field: "title", value: "invoice", action: "forward" }), TO, "sender@elsewhere.test", { subject: SUBJECT });
	assert.equal(forward?.action, "forward");
	assert.equal(forward?.forwardTo, "elsewhere@other.test");
});

test("a Subject rule only matches the given subject, using its operator", async (t) => {
	const db = await fixture(t, { field: "title", value: "invoice", operator: "starts_with" });
	assert.equal((await resolveInboundAddress(db, TO, "sender@elsewhere.test", { subject: "Invoice 4021" }))?.action, "store");
	assert.equal(await resolveInboundAddress(db, TO, "sender@elsewhere.test", { subject: "Re: Invoice 4021" }), null);
});

test("without a subject the same rule does not match, so the caller must pass it", async (t) => {
	const db = await fixture(t, { field: "title", value: "invoice" });
	assert.equal(await resolveInboundAddress(db, TO, "sender@elsewhere.test"), null);
});

test("recipient and sender rules keep working on the same message", async (t) => {
	const byRecipient = await resolveInboundAddress(await fixture(t, { field: "recipient", value: TO }), TO, "sender@elsewhere.test", { subject: SUBJECT });
	assert.equal(byRecipient?.ruleId, "rule");
	const bySender = await resolveInboundAddress(await fixture(t, { field: "sender", value: "sender@elsewhere.test" }), TO, "sender@elsewhere.test", { subject: SUBJECT });
	assert.equal(bySender?.ruleId, "rule");
});
