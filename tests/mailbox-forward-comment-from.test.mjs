import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// A mailbox forward rule is decided before the message is parsed, so it is handed the raw
// From header. RFC 5322 lets that header carry a comment outside the angle brackets
// (`bob@example.com (Work)`, `<bob@example.com> (via relay)`), and the header is not an
// address until the comment is removed. Folder, spam and trash rules compare the parsed
// From address, so a sender condition has to match the same sender in both places.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-forward-comment-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { resolveInboundAddress, resolveInboxRuleDestination, matchesRule } from "./src/lib/email/routing.ts";
		`,
		resolveDir: root,
		sourcefile: "forward-comment-entry.ts",
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
const { SqliteDatabase, applyMigrations, getDb, resolveInboundAddress, resolveInboxRuleDestination, matchesRule } = await import(
	pathToFileURL(join(directory, "entry.mjs")).href
);

const ENVELOPE = "bounce-921@example-jobs.test";

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
		"rule",
		rule.folderId ?? null,
		rule.value,
		rule.field ?? "email",
		rule.operator ?? "exact",
		rule.value,
		rule.action ?? "forward",
		rule.action && rule.action !== "forward" ? null : "elsewhere@other.test",
	);
	const env = { DB: database, MAILFLARE_RUNTIME: "node" };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	return getDb(env);
}

// The shapes a real From header takes. Every value names jobalerts-noreply@example-jobs.test.
const COMMENTED_HEADERS = [
	"jobalerts-noreply@example-jobs.test (Job Alerts)",
	'"Job Alerts" <jobalerts-noreply@example-jobs.test> (via example-jobs.test)',
	"Job Alerts <jobalerts-noreply@example-jobs.test> (noreply)",
];

for (const fromHeader of COMMENTED_HEADERS) {
	test(`a sender forward rule matches the commented From header ${fromHeader}`, async (t) => {
		const db = await fixture(t, { field: "email", value: "jobalerts-noreply@example-jobs.test" });
		const decision = await resolveInboundAddress(db, "me@one.test", ENVELOPE, {
			mailboxForwards: { subject: "New jobs for you", from: fromHeader },
		});
		assert.equal(decision?.action, "forward");
		assert.equal(decision?.forwardTo, "elsewhere@other.test");
	});
}

test("a sender rule matches the same commented header for a folder rule and a forward rule", async (t) => {
	const fromHeader = "jobalerts-noreply@example-jobs.test (Job Alerts)";
	const forward = await resolveInboundAddress(await fixture(t, { value: "jobalerts-noreply@example-jobs.test" }), "me@one.test", ENVELOPE, {
		mailboxForwards: { subject: "New jobs for you", from: fromHeader },
	});
	const folder = await resolveInboxRuleDestination(await fixture(t, { value: "jobalerts-noreply@example-jobs.test", action: "store", folderId: "alerts" }), {
		mailboxId: "box",
		toAddress: "me@one.test",
		fromAddress: fromHeader,
		subject: "New jobs for you",
	});

	assert.equal(forward?.action, "forward");
	assert.equal(folder.folderId, "alerts");
});

test("the comment does not change what a sender condition matches", () => {
	const rule = { pattern: "jobalerts-noreply@example-jobs.test", matchField: "sender", matchOperator: "exact", matchValue: "jobalerts-noreply@example-jobs.test" };
	assert.equal(matchesRule(rule, { toAddress: "me@one.test", fromAddress: "jobalerts-noreply@example-jobs.test (Job Alerts)" }), true);
	assert.equal(matchesRule(rule, { toAddress: "me@one.test", fromAddress: '"Job Alerts" <jobalerts-noreply@example-jobs.test> (Job Alerts)' }), true);
	// A different sender stays a different sender.
	assert.equal(matchesRule(rule, { toAddress: "me@one.test", fromAddress: "impostor@example-jobs.test (jobalerts-noreply@example-jobs.test)" }), false);
});

test("a sender rule keeps matching a header that carries no comment", async (t) => {
	const db = await fixture(t, { field: "email", value: "jobalerts-noreply@example-jobs.test" });
	for (const fromHeader of ["jobalerts-noreply@example-jobs.test", '"Job Alerts" <jobalerts-noreply@example-jobs.test>']) {
		const decision = await resolveInboundAddress(db, "me@one.test", ENVELOPE, {
			mailboxForwards: { subject: "New jobs for you", from: fromHeader },
		});
		assert.equal(decision?.action, "forward", fromHeader);
	}
});
