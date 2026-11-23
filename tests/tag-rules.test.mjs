import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Mailbox rules can match on the `+tag` of the recipient address. The tag is the
// verbatim text after the `+` (dots kept, unlike the dot-insensitive base), so a
// `receipts` rule files `user+receipts@…` mail while untagged mail never matches.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-tag-rules-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { matchesRule, resolveInboxRuleDestination } from "./src/lib/email/routing.ts";
			export { getRecipientTag, getRecipientTagFromList } from "./src/lib/email/recipient-tag.ts";
			export { routingRuleSchema } from "./src/lib/validators.ts";
		`,
		resolveDir: root,
		sourcefile: "tag-rules-test-entry.ts",
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
const {
	SqliteDatabase,
	applyMigrations,
	getDb,
	matchesRule,
	resolveInboxRuleDestination,
	getRecipientTag,
	getRecipientTagFromList,
	routingRuleSchema,
} = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const tagRule = (matchValue, matchOperator = "exact") => ({
	pattern: matchValue,
	matchField: "tag",
	matchOperator,
	matchValue,
});
const input = (toAddress, extra = {}) => ({ toAddress, fromAddress: "sender@other.test", ...extra });

test("a tag rule matches the +tag of the recipient, exact and contains", () => {
	assert.equal(matchesRule(tagRule("receipts"), input("user+receipts@one.test")), true);
	assert.equal(matchesRule(tagRule("ceipt", "contains"), input("user+receipts@one.test")), true);
	assert.equal(matchesRule(tagRule("receipts", "contains"), input("user+morereceipts@one.test")), true);
	assert.equal(matchesRule(tagRule("receipts"), input("user+other@one.test")), false);
});

test("a message with no tag never matches a tag rule", () => {
	for (const matchOperator of ["exact", "contains", "starts_with", "ends_with", "regex"]) {
		assert.equal(matchesRule(tagRule("receipts", matchOperator), input("user@one.test")), false, matchOperator);
	}
});

test("an empty +tag never matches", () => {
	assert.equal(matchesRule(tagRule("receipts"), input("user+@one.test")), false);
	assert.equal(matchesRule(tagRule("receipts", "contains"), input("user+@one.test")), false);
});

test("tag matching is case-insensitive", () => {
	assert.equal(matchesRule(tagRule("receipts"), input("User+RECEIPTS@one.test")), true);
	assert.equal(matchesRule(tagRule("RECEIPTS"), input("user+receipts@one.test")), true);
});

test("dots in a tag are verbatim, not stripped like the base address", () => {
	assert.equal(getRecipientTag("user+my.tag@one.test"), "my.tag");
	assert.equal(matchesRule(tagRule("my.tag"), input("user+my.tag@one.test")), true);
	// Dots are significant: `mytag` is a different tag than `my.tag`.
	assert.equal(matchesRule(tagRule("mytag"), input("user+my.tag@one.test")), false);
});

test("a leading + in the rule value is tolerated", () => {
	assert.equal(matchesRule(tagRule("+receipts"), input("user+receipts@one.test")), true);
	assert.equal(matchesRule(tagRule("+receipts", "contains"), input("user+receipts@one.test")), true);
	// Exactly one + is dropped, and a regex pattern sees the stripped value too.
	assert.equal(matchesRule(tagRule("+receipt.", "regex"), input("user+receipts@one.test")), true);
	assert.equal(matchesRule(tagRule("++odd", "exact"), input("user++odd@one.test")), true);
});

test("a tag rule reads the To address, never the sender", () => {
	assert.equal(
		matchesRule(tagRule("receipts"), input("user@one.test", { fromAddress: "news+receipts@other.test" })),
		false,
	);
});

test("other fields are unaffected", () => {
	// `email`/`recipient` still match the full tagged address, tag included.
	for (const matchField of ["email", "recipient"]) {
		const rule = { pattern: "", matchField, matchOperator: "exact", matchValue: "user+receipts@one.test" };
		assert.equal(matchesRule(rule, input("user+receipts@one.test")), true, matchField);
	}
	// A bare tag still cannot satisfy them: they compare whole addresses.
	const recipientRule = { pattern: "", matchField: "recipient", matchOperator: "exact", matchValue: "receipts" };
	assert.equal(matchesRule(recipientRule, input("user+receipts@one.test")), false);
	const titleRule = { pattern: "", matchField: "title", matchOperator: "contains", matchValue: "invoice" };
	assert.equal(matchesRule(titleRule, input("user@one.test", { subject: "Invoice #42" })), true);
});

test("tag extraction handles display names, multi-plus and missing bases", () => {
	assert.equal(getRecipientTag("Receipts <user+receipts@one.test>"), "receipts");
	assert.equal(getRecipientTag("user+a+b@one.test"), "a+b");
	assert.equal(getRecipientTag("user+@one.test"), "");
	assert.equal(getRecipientTag("+tag@one.test"), "");
	assert.equal(getRecipientTag("user@one.test"), "");
});

test("the first tagged recipient wins across a header list", () => {
	assert.equal(getRecipientTagFromList("other@x.test, user+receipts@one.test"), "receipts");
	assert.equal(getRecipientTagFromList("other+first@x.test, user+second@one.test"), "first");
	assert.equal(getRecipientTagFromList("other@x.test, user@one.test"), "");
});

test("the mailbox-rule schema accepts a bare tag value", () => {
	const parsed = routingRuleSchema.safeParse({
		mailboxId: "box",
		matchField: "tag",
		matchOperator: "exact",
		matchValue: "+receipts",
		destination: "spam",
	});
	assert.equal(parsed.success, true);
	assert.equal(parsed.data?.matchField, "tag");
});

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
			match_value, action, enabled, priority, created_at)
		VALUES ('rule', 'admin', 'one', 'mailbox', 'box', ?, ?, 'tag', 'exact', ?, ?, 1, 10, 1)
	`).run(rule.folderId ?? null, rule.matchValue, rule.matchValue, rule.action);
	const env = { DB: database, MAILFLARE_RUNTIME: "node" };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	return getDb(env);
}

test("a folder rule on the tag files the message", async (t) => {
	const db = await fixture(t, { matchValue: "receipts", action: "store", folderId: "alerts" });
	const filed = await resolveInboxRuleDestination(db, {
		mailboxId: "box",
		toAddress: "me+receipts@one.test",
		subject: "hi",
	});
	assert.deepEqual(filed, { status: "received", folderId: "alerts" });

	const untagged = await resolveInboxRuleDestination(db, { mailboxId: "box", toAddress: "me@one.test" });
	assert.deepEqual(untagged, { status: "received", folderId: null });
});

test("a tag rule can route the message to spam", async (t) => {
	const db = await fixture(t, { matchValue: "junk", action: "spam" });
	const decision = await resolveInboxRuleDestination(db, { mailboxId: "box", toAddress: "me+junk@one.test" });
	assert.deepEqual(decision, { status: "spam", folderId: null });
});
