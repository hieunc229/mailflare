import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

// The security-hardening migration adds messages.private_draft and backfills it for existing rows:
// every draft, and outbound mail in Trash, Archive or the inbox that was never submitted for sending.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { app } = await loadApp("private-draft-backfill", `
	export { currentChangeScope, emailChangesSince } from "./src/lib/jmap/changes.ts";
`);
const staging = mkdtempSync(join(root, "node_modules", "private-draft-backfill-migrations-"));
after(() => rmSync(staging, { recursive: true, force: true }));

test("existing drafts, and moved never-sent outbound mail, become private; sent mail does not", async (t) => {
	// A database as it was before the migration: everything up to it, applied.
	const source = join(root, "drizzle", "migrations");
	mkdirSync(join(staging, "meta"));
	for (const name of readdirSync(source)) if (name.endsWith(".sql") && !name.startsWith("0090_security_hardening")) cpSync(join(source, name), join(staging, name));
	const journal = JSON.parse(readFileSync(join(source, "meta", "_journal.json"), "utf8"));
	journal.entries = journal.entries.filter((entry) => entry.tag !== "0090_security_hardening");
	writeFileSync(join(staging, "meta", "_journal.json"), JSON.stringify(journal));
	const database = new app.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await app.applyMigrations(database, staging);
	assert.equal(database.db.prepare("SELECT 1 FROM pragma_table_info('messages') WHERE name = 'private_draft'").get(), undefined);

	database.db.exec(`${sharedMailboxSeed("full_access")}
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at) VALUES
			('draft', 'author', 'mb-team', 'outbound', 'a@example.com', 'x@example.net', 's', 'b', 'draft', 1),
			('draft-trash', 'author', 'mb-team', 'outbound', 'a@example.com', 'x@example.net', 's', 'b', 'trash', 2),
			('draft-archived', 'author', 'mb-team', 'outbound', 'a@example.com', 'x@example.net', 's', 'b', 'archived', 3),
			('draft-inbox', 'author', 'mb-team', 'outbound', 'a@example.com', 'x@example.net', 's', 'b', 'received', 4),
			('sent-trash', 'author', 'mb-team', 'outbound', 'a@example.com', 'x@example.net', 's', 'b', 'trash', 5),
			('sent-restored', 'author', 'mb-team', 'outbound', 'a@example.com', 'x@example.net', 's', 'b', 'received', 6),
			('sent', 'author', 'mb-team', 'outbound', 'a@example.com', 'x@example.net', 's', 'b', 'sent', 7),
			('failed', 'author', 'mb-team', 'outbound', 'a@example.com', 'x@example.net', 's', 'b', 'failed', 8),
			('inbound-trash', 'admin', 'mb-team', 'inbound', 'x@example.net', 'a@example.com', 's', 'b', 'trash', 9),
			('inbound-draft-status', 'admin', 'mb-team', 'inbound', 'x@example.net', 'a@example.com', 's', 'b', 'draft', 10);
		INSERT INTO outbound_jobs (id, message_id, user_id, status, payload, created_at, updated_at) VALUES
			('j1', 'sent-trash', 'author', 'sent', '{}', 1, 1),
			('j2', 'sent-restored', 'author', 'sent', '{}', 1, 1);
	`);
	// A JMAP client that synced before the migration, and may therefore cache other users' drafts.
	// A request context memoizes its change scope, so each call gets its own.
	const newCtx = () => ({ env: { DB: database }, db: app.getDb({ DB: database }), accountId: "acct", origin: "http://localhost", createdIds: {}, memo: undefined, auth: { userId: "delegate", user: { id: "delegate", email: "delegate@example.com", role: "user" }, scopes: ["jmap"], mailboxIds: null } });
	const before = await app.currentChangeScope(newCtx());
	assert.ok(before.seq > 0);
	assert.ok(!("type" in await app.emailChangesSince(newCtx(), { sinceState: before.state })), "valid before the migration");
	assert.deepEqual(await app.applyMigrations(database, join(root, "drizzle", "migrations")), ["0090_security_hardening.sql"]);
	// The migration raises the change floor past every state issued before it, so such clients resync.
	const floor = database.db.prepare("SELECT seq FROM jmap_change_floor WHERE id = 1").get().seq;
	assert.equal(floor, database.db.prepare("SELECT max(seq) AS seq FROM jmap_changes").get().seq);
	assert.ok(floor > before.seq);
	assert.equal((await app.emailChangesSince(newCtx(), { sinceState: before.state })).type, "cannotCalculateChanges");
	// A state issued afterwards is valid again.
	const after = await app.currentChangeScope(newCtx());
	const fresh = await app.emailChangesSince(newCtx(), { sinceState: after.state });
	assert.ok(!("type" in fresh), JSON.stringify([fresh, after]));
	const flags = Object.fromEntries(database.db.prepare("SELECT id, private_draft AS p FROM messages").all().map((row) => [row.id, row.p]));
	assert.deepEqual(flags, {
		draft: 1, "draft-trash": 1, "draft-archived": 1, "draft-inbox": 1, "inbound-draft-status": 1,
		"sent-trash": 0, "sent-restored": 0, sent: 0, failed: 0, "inbound-trash": 0,
	});
});
