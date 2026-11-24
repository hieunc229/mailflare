import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-bulk-mail-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { isBulkMail, hasListOrBulkPrecedence } from "./src/lib/email/bulk-mail.ts";
			export { matchesRule, resolveInboundAddress, resolveInboxRuleDestination } from "./src/lib/email/routing.ts";
			export { ruleErrorMessage, MAIL_TYPE_UNSAFE_ACTION } from "./src/lib/email/mail-type-rule.ts";
			export { routingRuleSchema, domainRoutingRuleSchema } from "./src/lib/validators.ts";
		`,
		resolveDir: root,
		sourcefile: "bulk-mail-test-entry.ts",
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

test("each bulk header marks mail as bulk, whatever its case", () => {
	assert.deepEqual(m.isBulkMail({ "List-Unsubscribe": "<mailto:u@x.test>" }), { bulk: true, reasons: ["list-unsubscribe"] });
	assert.deepEqual(m.isBulkMail({ "list-id": "<news.x.test>" }), { bulk: true, reasons: ["list-id"] });
	for (const value of ["bulk", "List", " JUNK "]) {
		assert.equal(m.isBulkMail({ Precedence: value }).bulk, true, value);
	}
	// Feedback-ID is only corroboration: it is kept as a reason beside a strong signal.
	assert.deepEqual(m.isBulkMail({ "Feedback-ID": "1:camp:news:esp", "List-Unsubscribe": "<x>" }), { bulk: true, reasons: ["list-unsubscribe", "feedback-id"] });
	assert.deepEqual(m.isBulkMail({ "X-Campaign": "spring" }).reasons, ["x-campaign"]);
	assert.deepEqual(m.isBulkMail({ "x-campaignid": "42" }).reasons, ["x-campaignid"]);
	assert.deepEqual(m.isBulkMail({ "X-Campaign-ID": "42" }).reasons, ["x-campaign-id"]);
	assert.deepEqual(m.isBulkMail({ "list-id": "a", "list-unsubscribe": "b", precedence: "bulk" }).reasons, ["list-unsubscribe", "list-id", "precedence: bulk"]);
});

test("personal mail, receipts and auto-replies are not bulk", () => {
	assert.deepEqual(m.isBulkMail({ from: "friend@x.test", subject: "Lunch?", "message-id": "<1@x.test>" }), { bulk: false, reasons: [] });
	// Transactional receipt that went through an ESP: trace headers only.
	assert.equal(m.isBulkMail({ "x-ses-outgoing": "2026.1.1-1.2.3.4", "x-sg-eid": "abc", "x-mailgun-tag": "receipt", "x-mailer": "app" }).bulk, false);
	// Auto-reply and normal precedence.
	assert.equal(m.isBulkMail({ "auto-submitted": "auto-replied", "x-auto-response-suppress": "All", precedence: "first-class" }).bulk, false);
	assert.equal(m.isBulkMail({ "list-id": "  ", "list-unsubscribe": "" }).bulk, false);
	// SES / Postmark / Google stamp Feedback-ID on transactional mail too (OTP, receipts): not bulk alone.
	assert.deepEqual(m.isBulkMail({ "Feedback-ID": "1.us-east-1.abc:AmazonSES", "X-SES-Outgoing": "2026.1.1-1.2.3.4", subject: "Your code" }), { bulk: false, reasons: [] });
	assert.equal(m.isBulkMail({ "feedback-id": "otp:acme:postmark" }).bulk, false);
	assert.equal(m.isBulkMail(undefined).bulk, false);
	assert.equal(m.isBulkMail(null).bulk, false);
});

test("hasListOrBulkPrecedence is the List-Id / Precedence subset", () => {
	assert.equal(m.hasListOrBulkPrecedence({ "List-Id": "x" }), true);
	assert.equal(m.hasListOrBulkPrecedence({ Precedence: "junk" }), true);
	assert.equal(m.hasListOrBulkPrecedence({ "list-unsubscribe": "x", "feedback-id": "y" }), false);
});

test("a mail_type rule matches bulk mail only", () => {
	const rule = { pattern: "bulk", matchField: "mail_type", matchOperator: "contains", matchValue: "bulk" };
	const base = { toAddress: "me@one.test", fromAddress: "a@b.test" };
	assert.equal(m.matchesRule(rule, { ...base, headers: { "list-unsubscribe": "<x>" } }), true);
	assert.equal(m.matchesRule(rule, { ...base, headers: { subject: "hi" } }), false);
	assert.equal(m.matchesRule(rule, base), false);
	assert.equal(m.matchesRule({ ...rule, matchValue: "*", pattern: "*" }, base), false);
	// Other fields are unaffected by headers.
	assert.equal(m.matchesRule({ pattern: "a@b.test", matchField: "sender", matchValue: "a@b.test" }, { ...base, headers: {} }), true);
});

test("mail_type is validated for mailbox and domain rules", () => {
	const mailbox = { mailboxId: "m", matchField: "mail_type", matchOperator: "contains", matchValue: "bulk", destination: "trash", priority: 1 };
	assert.equal(m.routingRuleSchema.safeParse(mailbox).success, true);
	assert.equal(m.routingRuleSchema.safeParse({ ...mailbox, matchValue: "spammy" }).success, false);
	const domain = { domainId: "d", matchField: "mail_type", matchValue: "bulk", action: "store", mailboxId: "m" };
	assert.equal(m.domainRoutingRuleSchema.safeParse(domain).success, true);
	assert.equal(m.domainRoutingRuleSchema.safeParse({ ...domain, matchValue: "x" }).success, false);
});

const UNSAFE = "mail_type_unsafe_action";
const codes = (result) => (result.success ? [] : result.error.issues.map((issue) => issue.message));

test("mail_type rules refuse actions that lose mail: reject and forward without a kept copy", () => {
	const domain = { domainId: "d", matchField: "mail_type", matchValue: "bulk", mailboxId: "m" };
	assert.deepEqual(codes(m.domainRoutingRuleSchema.safeParse({ ...domain, action: "reject" })), [UNSAFE]);
	assert.deepEqual(codes(m.domainRoutingRuleSchema.safeParse({ ...domain, action: "forward", forwardTo: "a@b.test" })), [UNSAFE]);
	assert.equal(m.domainRoutingRuleSchema.safeParse({ ...domain, action: "forward", forwardTo: "a@b.test", keepCopy: true }).success, true);
	// The same actions stay available for text conditions.
	assert.equal(m.domainRoutingRuleSchema.safeParse({ domainId: "d", matchField: "sender", matchValue: "x", action: "reject" }).success, true);
	assert.equal(m.domainRoutingRuleSchema.safeParse({ domainId: "d", matchField: "sender", matchValue: "x", action: "forward", forwardTo: "a@b.test" }).success, true);

	const mailbox = { mailboxId: "m", matchField: "mail_type", matchValue: "bulk" };
	assert.deepEqual(codes(m.routingRuleSchema.safeParse({ ...mailbox, destination: "forward", forwardTo: "a@b.test" })), [UNSAFE]);
	assert.deepEqual(codes(m.routingRuleSchema.safeParse({ ...mailbox, action: "reject", destination: "trash" })), [UNSAFE]);
	assert.deepEqual(codes(m.routingRuleSchema.safeParse({ ...mailbox, action: "forward", forwardTo: "a@b.test" })), [UNSAFE]);
	for (const destination of ["trash", "spam", "folder:f1"]) assert.equal(m.routingRuleSchema.safeParse({ ...mailbox, destination }).success, true, destination);
	assert.equal(m.routingRuleSchema.safeParse({ ...mailbox, destination: "forward", forwardTo: "a@b.test", keepCopy: true }).success, true);
	assert.equal(m.routingRuleSchema.safeParse({ mailboxId: "m", matchField: "email", matchValue: "x", destination: "forward", forwardTo: "a@b.test" }).success, true);
});

test("the rule API error maps to the translatable code", () => {
	const flat = m.routingRuleSchema.safeParse({ mailboxId: "m", matchField: "mail_type", matchValue: "bulk", destination: "forward", forwardTo: "a@b.test" }).error.flatten();
	assert.equal(m.ruleErrorMessage(flat, "fallback"), m.MAIL_TYPE_UNSAFE_ACTION);
	assert.equal(m.ruleErrorMessage("Folder not found", "fallback"), "Folder not found");
	assert.equal(m.ruleErrorMessage({ formErrors: [], fieldErrors: { matchValue: ["Required"] } }, "fallback"), "fallback");
});

async function fixture(t, rule) {
	const database = new m.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await m.applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('admin', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('one', 'admin', 'one.test', 'zone-one', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('box', 'admin', 'one', 'me', 1);
		INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('promos', 'admin', 'box', 'Promotions', 1);
	`);
	database.db.prepare(`
		INSERT INTO routing_rules (id, user_id, domain_id, scope, mailbox_id, folder_id, pattern, match_field, match_operator,
			match_value, action, forward_to, keep_copy, reject_reason, enabled, priority, created_at)
		VALUES ('rule', 'admin', 'one', ?, ?, ?, 'bulk', 'mail_type', 'contains', 'bulk', ?, ?, 0, 'no promos', 1, 10, 1)
	`).run(rule.scope, rule.scope === "mailbox" ? "box" : null, rule.folderId ?? null, rule.action, rule.forwardTo ?? null);
	const env = { DB: database, MAILFLARE_RUNTIME: "node" };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	return m.getDb(env);
}

const NEWSLETTER = { "list-unsubscribe": "<https://x.test/u>" };
const input = (headers) => ({ mailboxId: "box", toAddress: "me@one.test", fromAddress: "news@x.test", subject: "Sale", headers });

test("mailbox rule files newsletters into a folder, spam or trash", async (t) => {
	const folderDb = await fixture(t, { scope: "mailbox", action: "store", folderId: "promos" });
	assert.deepEqual(await m.resolveInboxRuleDestination(folderDb, input(NEWSLETTER)), { status: "received", folderId: "promos" });
	assert.deepEqual(await m.resolveInboxRuleDestination(folderDb, input({ subject: "Lunch" })), { status: "received", folderId: null });
});

test("mailbox trash rule", async (t) => {
	const db = await fixture(t, { scope: "mailbox", action: "trash" });
	assert.equal((await m.resolveInboxRuleDestination(db, input(NEWSLETTER))).status, "trash");
	assert.equal((await m.resolveInboxRuleDestination(db, input({}))).status, "received");
});

test("runtime backstop: a stored mail_type reject row never rejects", async (t) => {
	const db = await fixture(t, { scope: "domain", action: "reject" });
	const hit = await m.resolveInboundAddress(db, "me@one.test", "news@x.test", { headers: NEWSLETTER });
	assert.equal(hit?.action, "store");
});

test("mailbox forward rule forwards bulk mail only", async (t) => {
	const db = await fixture(t, { scope: "mailbox", action: "forward", forwardTo: "archive@other.test" });
	const hit = await m.resolveInboundAddress(db, "me@one.test", "news@x.test", { headers: NEWSLETTER, mailboxForwards: { subject: "Sale" } });
	assert.equal(hit?.action, "forward");
	assert.equal(hit?.keepCopy, true);
	const miss = await m.resolveInboundAddress(db, "me@one.test", "friend@x.test", { headers: {}, mailboxForwards: { subject: "Hi" } });
	assert.equal(miss?.action, "store");
});

test("runtime backstop: a domain mail_type forward without a copy target is skipped", async (t) => {
	const db = await fixture(t, { scope: "domain", action: "forward", forwardTo: "archive@other.test" });
	const hit = await m.resolveInboundAddress(db, "nobody@one.test", "news@x.test", { headers: NEWSLETTER });
	assert.notEqual(hit?.action, "forward");
});

test("isBulkMail ignores non-string header values", () => {
	assert.deepEqual(m.isBulkMail({ "list-id": 1 }), { bulk: false, reasons: [] });
	assert.equal(m.isBulkMail({ "list-id": 1, "list-unsubscribe": "<https://x.test/u>" }).bulk, true);
	assert.equal(m.hasListOrBulkPrecedence({ "list-id": 1 }), false);
});
