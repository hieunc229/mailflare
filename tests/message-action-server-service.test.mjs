import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-undo-service-"));
after(() => rmSync(directory, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export {
				applyMessageActionForUser, undoMessageActionForUser, MessageActionError,
			} from "./src/lib/messages/actions/service.ts";
		`,
		resolveDir: root,
		sourcefile: "message-action-service-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
	plugins: [{
		name: "message-action-service-mocks",
		setup(builder) {
			const alias = (filter, namespace, contents) => {
				builder.onResolve({ filter }, () => ({ path: namespace, namespace }));
				builder.onLoad({ filter: /.*/, namespace }, () => ({ contents, loader: "js" }));
			};
			alias(/^@\/db$/, "mock-db", "export function getDb() { return globalThis.__messageDb; }");
			alias(/^@\/lib\/mailboxes\/access$/, "mock-access", `
				export async function getMailboxAccessLevel() {
					return { canRead: true, canManage: true };
				}
			`);
			alias(/^@\/lib\/mailboxes\/audit$/, "mock-audit", "export async function createAuditLogs() {}");
			alias(/^@\/lib\/spam\/feedback$/, "mock-spam", `
				export async function applySpamFeedback(_env, _user, messageId, classification) {
					const status = classification === "spam" ? "spam" : "received";
					globalThis.__rawSqlite.prepare("UPDATE messages SET status = ?, folder_id = NULL WHERE id = ?").run(status, messageId);
					return true;
				}
			`);
			alias(/^@\/lib\/security\/server-secret$/, "mock-secret", "export async function getServerSecret() { return 'message-action-test-secret'; }");
		},
	}],
});
const m = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const sqlite = new Database(":memory:");
sqlite.exec(`
	CREATE TABLE messages (
		id text PRIMARY KEY NOT NULL,
		mailbox_id text,
		direction text NOT NULL,
		status text NOT NULL,
		read integer NOT NULL,
		starred integer NOT NULL,
		folder_id text,
		snoozed_until integer
	);
	CREATE TABLE folders (
		id text PRIMARY KEY NOT NULL,
		mailbox_id text NOT NULL
	);
	CREATE TABLE message_action_undo_claims (
		nonce text PRIMARY KEY NOT NULL,
		user_id text NOT NULL,
		expires_at integer NOT NULL
	);
	CREATE INDEX message_action_undo_claims_expires_idx ON message_action_undo_claims (expires_at);
`);
globalThis.__messageDb = drizzle(sqlite);
globalThis.__rawSqlite = sqlite;
after(() => sqlite.close());

const user = { id: "user-1" };

function reset(message = {}) {
	sqlite.exec("DELETE FROM messages; DELETE FROM message_action_undo_claims; DELETE FROM folders;");
	const row = {
		id: "m1",
		mailboxId: "mb1",
		direction: "inbound",
		status: "received",
		read: 0,
		starred: 0,
		folderId: null,
		snoozedUntil: null,
		...message,
	};
	sqlite.prepare("INSERT INTO messages (id, mailbox_id, direction, status, read, starred, folder_id, snoozed_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
		.run(row.id, row.mailboxId, row.direction, row.status, row.read, row.starred, row.folderId, row.snoozedUntil);
	return row;
}

function rowState(id = "m1") {
	return sqlite.prepare("SELECT status, read, starred, folder_id, snoozed_until FROM messages WHERE id = ?").get(id);
}

test("apply signs the server CAS result and undo restores it exactly once", async () => {
	reset();
	const applied = await m.applyMessageActionForUser({}, user, { action: "archive", messageIds: ["m1"] });
	assert.equal(applied.applied.length, 1);
	assert.ok(applied.undoToken);
	assert.deepEqual(rowState(), { status: "archived", read: 0, starred: 0, folder_id: null, snoozed_until: null });

	const undo = await m.undoMessageActionForUser({}, user, applied.undoToken);
	assert.deepEqual(undo.restored, ["m1"]);
	assert.equal(rowState().status, "received");
	await assert.rejects(
		m.undoMessageActionForUser({}, user, applied.undoToken),
		(error) => error instanceof m.MessageActionError && error.status === 410,
	);
});

test("undo tokens are bound to the user who received them", async () => {
	reset();
	const applied = await m.applyMessageActionForUser({}, user, { action: "star", messageIds: ["m1"] });
	await assert.rejects(
		m.undoMessageActionForUser({}, { id: "user-2" }, applied.undoToken),
		(error) => error instanceof m.MessageActionError && error.status === 410,
	);
	assert.equal(rowState().starred, 1);
	const undo = await m.undoMessageActionForUser({}, user, applied.undoToken);
	assert.deepEqual(undo.restored, ["m1"]);
	assert.equal(rowState().starred, 0);
});

test("a mixed undo restores only rows still holding the action's applied state", async () => {
	reset();
	sqlite.prepare("INSERT INTO messages (id, mailbox_id, direction, status, read, starred, folder_id, snoozed_until) VALUES ('m2', 'mb1', 'inbound', 'received', 0, 0, NULL, NULL)").run();
	const applied = await m.applyMessageActionForUser({}, user, { action: "read", messageIds: ["m1", "m2"] });
	assert.equal(applied.applied.length, 2);
	sqlite.prepare("UPDATE messages SET read = 0 WHERE id = 'm2'").run();
	const undo = await m.undoMessageActionForUser({}, user, applied.undoToken);
	assert.deepEqual(undo.restored, ["m1"]);
	assert.deepEqual(undo.skipped, [{ id: "m2", reason: "stale" }]);
	assert.equal(rowState("m1").read, 0);
	assert.equal(rowState("m2").read, 0);
	// A stale-only settle keeps the one-time claim consumed.
	await assert.rejects(
		m.undoMessageActionForUser({}, user, applied.undoToken),
		(error) => error instanceof m.MessageActionError && error.status === 410,
	);
});

test("spam and inbox-from-spam apply normally but never issue an undo token", async () => {
	reset();
	const spam = await m.applyMessageActionForUser({}, user, { action: "spam", messageIds: ["m1"] });
	assert.equal(spam.undoToken, undefined);
	assert.equal(rowState().status, "spam");

	reset({ status: "spam" });
	const inbox = await m.applyMessageActionForUser({}, user, { action: "inbox", messageIds: ["m1"] });
	assert.equal(inbox.undoToken, undefined);
	assert.equal(rowState().status, "received");
});

test("only actually changed rows are reported as applied", async () => {
	reset({ status: "archived" });
	const applied = await m.applyMessageActionForUser({}, user, { action: "archive", messageIds: ["m1"] });
	assert.deepEqual(applied.applied, []);
	assert.equal(applied.undoToken, undefined);
});

test("a CAS race rejects a stale archive snapshot instead of signing it", async () => {
	reset();
	// Simulates the row being changed between the service's read and its CAS
	// write: the conditional UPDATE affects no row, so nothing is signed.
	sqlite.exec(`
		CREATE TRIGGER block_archive BEFORE UPDATE OF status ON messages
		WHEN OLD.id = 'm1' AND NEW.status = 'archived'
		BEGIN
			SELECT RAISE(IGNORE);
		END;
	`);
	const applied = await m.applyMessageActionForUser({}, user, { action: "archive", messageIds: ["m1"] });
	assert.deepEqual(applied.applied, []);
	assert.deepEqual(applied.skipped, [{ id: "m1", reason: "stale" }]);
	assert.equal(applied.undoToken, undefined);
	sqlite.exec("DROP TRIGGER block_archive");
});
