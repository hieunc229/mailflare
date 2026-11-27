import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-plus-test-"));
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
		sourcefile: "plus-addressing-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "next/headers": "next/headers.js", "next/server": "next/server.js", "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, getDb, resolveInboundAddress } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

async function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES
			('admin', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES
			('one', 'admin', 'one.test', 'manual', 'active', 1),
			('two', 'admin', 'two.test', 'manual', 'active', 1);
	`);
	return { database, db: getDb({ DB: database, MAILFLARE_RUNTIME: "node" }) };
}

function insertMailbox(f, id, localPart, { domainId = "one", useAllDomains = 0 } = {}) {
	f.database.db
		.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, use_all_domains, created_at) VALUES (?, 'admin', ?, ?, ?, 1)")
		.run(id, domainId, localPart, useAllDomains);
}

function insertAlias(f, id, mailboxId, localPart, { domainId = "one", enabled = 1 } = {}) {
	f.database.db
		.prepare("INSERT INTO mailbox_aliases (id, mailbox_id, domain_id, local_part, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1)")
		.run(id, mailboxId, domainId, localPart, enabled);
}

function insertRule(f, id, { action, matchValue = "*", mailboxId = null, forwardTo = null, priority = 0 }) {
	f.database.db
		.prepare(`INSERT INTO routing_rules
			(id, user_id, domain_id, scope, name, enabled, pattern, match_field, match_operator, match_value, mailbox_id, action, forward_to, priority, created_at)
			VALUES (?, 'admin', 'one', 'domain', ?, 1, ?, 'recipient', 'exact', ?, ?, ?, ?, ?, 1)`)
		.run(id, `${action} rule`, matchValue, matchValue, mailboxId, action, forwardTo, priority);
}

test("a tagged address delivers to the base mailbox", async (t) => {
	const f = await fixture(t);
	insertMailbox(f, "mb", "user");
	for (const to of ["user+tag@one.test", "User+TAG@one.test", "u.ser+tag@one.test", "user+a+b@one.test"]) {
		const decision = await resolveInboundAddress(f.db, to);
		assert.equal(decision?.action, "store", to);
		assert.equal(decision?.mailbox?.mailboxId, "mb", to);
	}
});

test("a tagged address resolves through a base alias", async (t) => {
	const f = await fixture(t);
	insertMailbox(f, "mb", "sam");
	insertAlias(f, "alias", "mb", "sales");
	const decision = await resolveInboundAddress(f.db, "sales+tag@one.test");
	assert.equal(decision?.mailbox?.mailboxId, "mb");
});

test("a literal tagged mailbox wins over the base mailbox", async (t) => {
	const f = await fixture(t);
	insertMailbox(f, "mb-base", "user");
	insertMailbox(f, "mb-tag", "user+tag");
	assert.equal((await resolveInboundAddress(f.db, "user+tag@one.test"))?.mailbox?.mailboxId, "mb-tag");
	// A different tag still falls back to the base mailbox, never to `user+other`.
	insertMailbox(f, "mb-other", "user+other");
	assert.equal((await resolveInboundAddress(f.db, "user+else@one.test"))?.mailbox?.mailboxId, "mb-base");
});

test("a literal tagged alias wins over the base mailbox", async (t) => {
	const f = await fixture(t);
	insertMailbox(f, "mb-base", "user");
	insertMailbox(f, "mb-other", "other");
	insertAlias(f, "tag-alias", "mb-other", "user+tag");
	assert.equal((await resolveInboundAddress(f.db, "user+tag@one.test"))?.mailbox?.mailboxId, "mb-other");
});

test("reject rules still run first and match the full tagged address", async (t) => {
	const f = await fixture(t);
	insertMailbox(f, "mb", "user");
	insertRule(f, "block", { action: "reject", matchValue: "user+tag@one.test" });
	const decision = await resolveInboundAddress(f.db, "user+tag@one.test");
	assert.equal(decision?.action, "reject");
	assert.equal(decision?.ruleId, "block");
});

test("a catch-all store rule still claims an unknown tagged address", async (t) => {
	const f = await fixture(t);
	insertMailbox(f, "mb", "user");
	insertMailbox(f, "catch", "catchall");
	insertRule(f, "all", { action: "store", mailboxId: "catch" });
	// The base mailbox keeps winning over the catch-all for tagged mail.
	assert.equal((await resolveInboundAddress(f.db, "user+tag@one.test"))?.mailbox?.mailboxId, "mb");
	// An unclaimed tagged address reaches the catch-all, not a null bounce.
	const decision = await resolveInboundAddress(f.db, "ghost+tag@one.test");
	assert.equal(decision?.action, "store");
	assert.equal(decision?.mailbox?.mailboxId, "catch");
	assert.equal(decision?.ruleId, "all");
});

test("an empty tag does not split", async (t) => {
	const f = await fixture(t);
	insertMailbox(f, "mb", "user");
	insertMailbox(f, "catch", "catchall");
	insertRule(f, "all", { action: "store", mailboxId: "catch" });
	// `user+` is a literal address, so it bypasses the `user` mailbox for the catch-all.
	const decision = await resolveInboundAddress(f.db, "user+@one.test");
	assert.equal(decision?.mailbox?.mailboxId, "catch");
});

test("a disabled tagged alias keeps owning its address", async (t) => {
	const f = await fixture(t);
	insertMailbox(f, "mb", "user");
	insertMailbox(f, "mb-other", "other");
	insertAlias(f, "tag-alias", "mb-other", "user+tag", { enabled: 0 });
	insertMailbox(f, "catch", "catchall");
	insertRule(f, "all", { action: "store", mailboxId: "catch" });
	const decision = await resolveInboundAddress(f.db, "user+tag@one.test");
	assert.equal(decision?.action, "reject");
	assert.equal(decision?.rejectReason, "Mailbox unavailable");
});

test("a missing base is not deliverable", async (t) => {
	const f = await fixture(t);
	insertMailbox(f, "mb", "user");
	for (const to of ["+tag@one.test", "+@one.test"]) {
		assert.equal(await resolveInboundAddress(f.db, to), null, to);
	}
});

test("an all-domains mailbox receives tagged mail on its other domains", async (t) => {
	const f = await fixture(t);
	insertMailbox(f, "mb", "user", { useAllDomains: 1 });
	assert.equal((await resolveInboundAddress(f.db, "user+tag@two.test"))?.mailbox?.mailboxId, "mb");
});
