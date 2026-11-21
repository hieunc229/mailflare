import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(process.env.TMPDIR ?? root, "mailflare-imap-sync-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { syncMailbox, syncMailboxUnserialized, SYNC_STEP, BUMP_CHUNK } from "./src/lib/imap/sync.ts";
		`,
		resolveDir: root,
		sourcefile: "imap-sync-test-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, syncMailbox, syncMailboxUnserialized, SYNC_STEP, BUMP_CHUNK } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

/**
 * Counts what each statement binds and how large each batch is, to hold the D1 limits, and lets a test run
 * code at chosen moments (`beforeAll`, `beforeBatch`, `afterBatch`) to play a second writer. Batches are
 * atomic and one at a time, like transactions that take the same row lock; reads from different syncs interleave freely.
 */
function spy(database) {
	const seen = { maxParams: 0, maxBatch: 0, beforeRun: null, beforeAll: null, beforeBatch: null, afterBatch: null, batches: [], runs: [] };
	let queue = Promise.resolve();
	return {
		seen,
		prepare(sql) {
			const statement = database.prepare(sql);
			const wrap = (inner) => ({
				sql,
				bind(...values) {
					seen.maxParams = Math.max(seen.maxParams, values.length);
					return wrap(inner.bind(...values));
				},
				run: () => {
					seen.beforeRun?.(sql);
					seen.runs.push(sql);
					return inner.run();
				},
				all: () => { seen.beforeAll?.(sql); return inner.all(); },
				first: (column) => inner.first(column),
				raw: (options) => inner.raw(options),
				inner,
			});
			return wrap(statement);
		},
		async batch(statements) {
			seen.maxBatch = Math.max(seen.maxBatch, statements.length);
			await seen.beforeBatch?.(statements.map((statement) => statement.sql));
			const turn = queue.then(async () => {
				const results = await database.batch(statements.map((statement) => statement.inner));
				seen.batches.push({ sqls: statements.map((statement) => statement.sql), changes: results.map((result) => result.meta?.changes ?? 0) });
				await seen.afterBatch?.();
				return results;
			});
			queue = turn.then(() => undefined, () => undefined);
			return turn;
		},
	};
}

async function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const sqlite = database.db;
	sqlite.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('u1', 'u1@example.test', 'x', 'U', 'user', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.test', 'z', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('m1', 'u1', 'd1', 'me', 1), ('m2', 'u1', 'd1', 'other', 1);
	`);
	const db = spy(database);
	const env = { DB: db };
	db.seen.env = env;
	let clock = 1000;
	let counter = 0;
	const add = (overrides = {}) => {
		const id = overrides.id ?? `g${++counter}`;
		const row = { user_id: "u1", mailbox_id: "m1", direction: "inbound", from_addr: "a@b.test", to_addr: "me@example.test", status: "received", subject: "s", text_body: "t", html_body: null, created_at: ++clock, ...overrides, id };
		const names = Object.keys(row);
		sqlite.prepare(`INSERT INTO messages (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...Object.values(row));
		return id;
	};
	const uids = (folder = "inbox", mailbox = "m1") => sqlite.prepare("SELECT uid, message_id, modseq FROM imap_uids WHERE mailbox_id = ? AND folder_key = ? ORDER BY uid").all(mailbox, folder);
	const folderState = (folder = "inbox", mailbox = "m1") => sqlite.prepare("SELECT * FROM imap_folder_state WHERE id = ?").get(`${mailbox}:${folder}`);
	const expunged = (folder = "inbox", mailbox = "m1") => sqlite.prepare("SELECT uid, modseq FROM imap_expunged WHERE mailbox_id = ? AND folder_key = ? ORDER BY uid").all(mailbox, folder);
	const mailboxState = (mailbox = "m1") => sqlite.prepare("SELECT * FROM imap_mailbox_state WHERE mailbox_id = ?").get(mailbox);
	const sync = (mailbox = "m1") => syncMailbox(env, mailbox);
	return { database, sqlite, env, seen: db.seen, add, uids, folderState, expunged, mailboxState, sync };
}

test("inbound mail gets UIDs 1, 2, 3 in arrival order and the next one gets 4", async (t) => {
	const { add, uids, sync, folderState } = await fixture(t);
	await sync();
	const [a, b, c] = [add(), add(), add()];
	await sync();
	assert.deepEqual(uids().map((row) => [row.uid, row.message_id]), [[1, a], [2, b], [3, c]]);
	const d = add();
	await sync();
	assert.deepEqual(uids().map((row) => row.uid), [1, 2, 3, 4]);
	assert.equal(uids()[3].message_id, d);
	assert.equal(folderState().uid_next, 5);
	assert.ok(folderState().uidvalidity > 1_700_000_000, "UIDVALIDITY is unix seconds at creation");
});

test("the first sync of a populated mailbox assigns UIDs in created_at then id order", async (t) => {
	const { add, uids, sync } = await fixture(t);
	const late = add({ created_at: 5000 });
	const early = add({ created_at: 10 });
	const tieB = add({ id: "b", created_at: 20 });
	const tieA = add({ id: "a", created_at: 20 });
	await sync();
	assert.deepEqual(uids().map((row) => row.message_id), [early, tieA, tieB, late]);
});

test("starring in the web UI bumps the modseq and keeps the UID", async (t) => {
	const { add, sqlite, uids, sync, folderState, mailboxState } = await fixture(t);
	const first = add();
	add();
	await sync();
	const before = uids();
	sqlite.prepare("UPDATE messages SET starred = 1 WHERE id = ?").run(first);
	await sync();
	const after = uids();
	assert.equal(after[0].uid, before[0].uid);
	assert.ok(after[0].modseq > before[0].modseq);
	assert.equal(after[1].modseq, before[1].modseq, "the untouched message keeps its modseq");
	assert.equal(folderState().highest_modseq, after[0].modseq);
	assert.ok(mailboxState().modseq >= after[0].modseq);
});

test("moving a message expunges it from the old folder and gives it a new UID in the new one", async (t) => {
	const { add, sqlite, uids, sync, expunged, folderState } = await fixture(t);
	const keep = add();
	const moved = add();
	await sync();
	sqlite.prepare("UPDATE messages SET status = 'archived' WHERE id = ?").run(moved);
	await sync();
	assert.deepEqual(uids("inbox").map((row) => row.message_id), [keep]);
	assert.deepEqual(uids("archive").map((row) => [row.uid, row.message_id]), [[1, moved]]);
	const gone = expunged("inbox");
	assert.equal(gone.length, 1);
	assert.equal(gone[0].uid, 2);
	assert.ok(gone[0].modseq > 0);
	assert.equal(folderState("inbox").uid_next, 3, "the inbox does not reuse UID 2");
	assert.ok(folderState("archive").highest_modseq > gone[0].modseq, "the new UID has a later modseq than the expunge");
});

test("moving into a user folder uses the f:<id> key", async (t) => {
	const { add, sqlite, uids, sync } = await fixture(t);
	sqlite.prepare("INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fl1', 'u1', 'm1', 'Clients', 1)").run();
	const id = add();
	await sync();
	sqlite.prepare("UPDATE messages SET folder_id = 'fl1' WHERE id = ?").run(id);
	await sync();
	assert.deepEqual(uids("f:fl1").map((row) => row.message_id), [id]);
	assert.equal(uids("inbox").length, 0);
});

test("deleting a message expunges its UID and UIDs are never reused", async (t) => {
	const { add, sqlite, uids, sync, expunged } = await fixture(t);
	const [a, b, c] = [add(), add(), add()];
	await sync();
	sqlite.prepare("DELETE FROM messages WHERE id = ?").run(c);
	await sync();
	assert.deepEqual(uids().map((row) => row.message_id), [a, b]);
	assert.deepEqual(expunged().map((row) => row.uid), [3]);
	const d = add();
	await sync();
	assert.deepEqual(uids().map((row) => [row.uid, row.message_id]), [[1, a], [2, b], [4, d]]);
});

test("a message moved to another mailbox leaves the first mailbox and appears in the second", async (t) => {
	const { add, sqlite, uids, sync } = await fixture(t);
	const id = add();
	await sync();
	await sync("m2");
	sqlite.prepare("UPDATE messages SET mailbox_id = 'm2' WHERE id = ?").run(id);
	await sync();
	await sync("m2");
	assert.equal(uids("inbox", "m1").length, 0);
	assert.deepEqual(uids("inbox", "m2").map((row) => row.message_id), [id]);
});

test("a message with no folder gets a UID only once it has one", async (t) => {
	const { add, sqlite, uids, sync } = await fixture(t);
	const id = add({ status: "sending", direction: "outbound" });
	await sync();
	assert.equal(uids("sent").length, 0);
	sqlite.prepare("UPDATE messages SET status = 'sent' WHERE id = ?").run(id);
	await sync();
	assert.deepEqual(uids("sent").map((row) => row.message_id), [id]);
});

test("a draft whose content changes is replaced by a new UID; other updates keep it", async (t) => {
	const { add, sqlite, uids, sync, expunged } = await fixture(t);
	const id = add({ status: "draft", direction: "outbound", subject: "Hello", text_body: "v1" });
	await sync();
	sqlite.prepare("INSERT INTO imap_message_cache (message_id, size, envelope, bodystructure, header_size) VALUES (?, 1, '{}', '{}', 1)").run(id);
	assert.equal(uids("drafts").length, 1);
	const first = uids("drafts")[0];
	assert.ok(sqlite.prepare("SELECT content_hash FROM imap_uids WHERE message_id = ?").get(id).content_hash, "drafts record a content hash");

	sqlite.prepare("UPDATE messages SET starred = 1 WHERE id = ?").run(id);
	await sync();
	assert.equal(uids("drafts")[0].uid, first.uid, "a flag change keeps the draft's UID");
	assert.ok(uids("drafts")[0].modseq > first.modseq);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM imap_message_cache WHERE message_id = ?").get(id).n, 1);

	sqlite.prepare("UPDATE messages SET text_body = 'v2' WHERE id = ?").run(id);
	await sync();
	assert.deepEqual(uids("drafts").map((row) => row.uid), [2]);
	assert.deepEqual(expunged("drafts").map((row) => row.uid), [1]);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM imap_message_cache WHERE message_id = ?").get(id).n, 0, "the cache is dropped with the old UID");
});

test("a draft with a changed attachment set is replaced", async (t) => {
	const { add, sqlite, uids, sync } = await fixture(t);
	const id = add({ status: "draft", direction: "outbound" });
	await sync();
	sqlite.prepare("INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, created_at) VALUES ('at1', ?, 'f.txt', 'text/plain', 1, 'k', 1)").run(id);
	sqlite.prepare("UPDATE messages SET snippet = 'x' WHERE id = ?").run(id);
	await sync();
	assert.deepEqual(uids("drafts").map((row) => row.uid), [2]);
});

test("a draft whose sender, reply-to or attachment trash changes is replaced and its cache dropped", async (t) => {
	const { add, sqlite, uids, sync, expunged } = await fixture(t);
	const id = add({ status: "draft", direction: "outbound" });
	sqlite.prepare("INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, created_at) VALUES ('at1', ?, 'f.txt', 'text/plain', 1, 'k', 1)").run(id);
	await sync();
	const cached = () => sqlite.prepare("SELECT COUNT(*) AS n FROM imap_message_cache WHERE message_id = ?").get(id).n;
	const cache = () => sqlite.prepare("INSERT INTO imap_message_cache (message_id, size, envelope, bodystructure, header_size) VALUES (?, 1, '{}', '{}', 1)").run(id);
	const edits = [
		"UPDATE messages SET from_addr = 'other@example.test' WHERE id = ?",
		"UPDATE messages SET reply_to = 'reply@example.test' WHERE id = ?",
		"UPDATE message_attachments SET trashed_at = 5 WHERE message_id = ?",
	];
	for (const [index, edit] of edits.entries()) {
		cache();
		sqlite.prepare(edit).run(id);
		sqlite.prepare("UPDATE messages SET snippet = ? WHERE id = ?").run(`edit ${index}`, id);
		await sync();
		assert.deepEqual(uids("drafts").map((row) => row.uid), [index + 2], edit);
		assert.deepEqual(expunged("drafts").map((row) => row.uid), Array.from({ length: index + 1 }, (_, n) => n + 1), edit);
		assert.equal(cached(), 0, `the cache is dropped: ${edit}`);
	}
});

test("a sync with nothing to do writes nothing", async (t) => {
	const { add, sqlite, sync } = await fixture(t);
	add();
	await sync();
	const writes = () => sqlite.prepare("SELECT total_changes() AS n").get().n;
	const before = writes();
	await sync();
	await sync();
	assert.equal(writes(), before);
});

test("when the change log was pruned past the saved position the mailbox is fully reconciled", async (t) => {
	const { add, sqlite, uids, sync, mailboxState, expunged } = await fixture(t);
	const keep = add();
	const stale = add();
	await sync();
	const before = uids();
	// Changes the IMAP side never saw, then the retention job drops them and raises the floor.
	sqlite.prepare("UPDATE messages SET starred = 1 WHERE id = ?").run(keep);
	sqlite.prepare("DELETE FROM messages WHERE id = ?").run(stale);
	const fresh = add();
	const top = sqlite.prepare("SELECT max(seq) AS seq FROM jmap_changes").get().seq;
	sqlite.prepare("DELETE FROM jmap_changes").run();
	sqlite.prepare("UPDATE jmap_change_floor SET seq = ? WHERE id = 1").run(top);
	await sync();
	assert.deepEqual(uids().map((row) => row.message_id), [keep, fresh]);
	assert.deepEqual(expunged().map((row) => row.uid), [2]);
	assert.equal(uids()[1].uid, 3, "the new message continues the UID sequence");
	assert.ok(uids()[0].modseq > before[0].modseq, "flag changes the log no longer shows are announced by a new modseq");
	assert.equal(mailboxState().jmap_seq, top);
	const writes = () => sqlite.prepare("SELECT total_changes() AS n").get().n;
	const settled = writes();
	await sync();
	assert.equal(writes(), settled, "the next sync is incremental and idle");
});

test("a folder deleted while IMAP was not looking is dropped by the reconcile", async (t) => {
	const { add, sqlite, uids, sync, folderState } = await fixture(t);
	sqlite.prepare("INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fl1', 'u1', 'm1', 'Old', 1)").run();
	add({ folder_id: "fl1" });
	await sync();
	assert.equal(uids("f:fl1").length, 1);
	sqlite.prepare("DELETE FROM folders WHERE id = 'fl1'").run();
	const top = sqlite.prepare("SELECT max(seq) AS seq FROM jmap_changes").get().seq;
	sqlite.prepare("DELETE FROM jmap_changes").run();
	sqlite.prepare("UPDATE jmap_change_floor SET seq = ? WHERE id = 1").run(top);
	await sync();
	assert.equal(uids("f:fl1").length, 0);
	assert.equal(folderState("f:fl1"), undefined);
	assert.equal(uids("inbox").length, 1, "its message fell back to the inbox");
});

test("two syncs racing without the mutex never hand out the same UID", async (t) => {
	const { add, sqlite, uids, env, sync } = await fixture(t);
	await sync();
	for (let index = 0; index < 6; index += 1) add();
	await Promise.all([syncMailboxUnserialized(env, "m1"), syncMailboxUnserialized(env, "m1"), syncMailboxUnserialized(env, "m1")]);
	const rows = uids();
	assert.deepEqual(rows.map((row) => row.uid), [1, 2, 3, 4, 5, 6]);
	assert.equal(new Set(rows.map((row) => row.message_id)).size, 6);
	assert.equal(sqlite.prepare("SELECT uid_next FROM imap_folder_state WHERE id = 'm1:inbox'").get().uid_next >= 7, true);
});

test("racing first syncs of the same mailbox end with one consistent state", async (t) => {
	const { add, uids, env } = await fixture(t);
	for (let index = 0; index < 4; index += 1) add();
	await Promise.all([syncMailboxUnserialized(env, "m1"), syncMailboxUnserialized(env, "m1")]);
	assert.deepEqual(uids().map((row) => row.uid), [1, 2, 3, 4]);
});

test("a UID at or above uid_next resets the folder under a new UIDVALIDITY", async (t) => {
	const { add, sqlite, uids, sync, folderState } = await fixture(t);
	const [a, b] = [add(), add()];
	await sync();
	const old = folderState().uidvalidity;
	sqlite.prepare("UPDATE imap_folder_state SET uid_next = 1 WHERE id = 'm1:inbox'").run();
	const c = add();
	await sync();
	assert.ok(folderState().uidvalidity > old, "a new UIDVALIDITY tells clients to resync");
	assert.deepEqual(uids().map((row) => row.uid), [1, 2, 3]);
	assert.deepEqual(new Set(uids().map((row) => row.message_id)), new Set([a, b, c]));
	assert.equal(folderState().uid_next, 4);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM imap_expunged WHERE mailbox_id = 'm1' AND folder_key = 'inbox'").get().n, 0);
});

test("a large backlog is processed in bounded steps within the D1 limits", async (t) => {
	const { add, sqlite, uids, sync, seen } = await fixture(t);
	await sync();
	const total = SYNC_STEP * 3 + 7;
	for (let index = 0; index < total; index += 1) add();
	await sync();
	assert.equal(uids().length, total);
	assert.deepEqual(uids().map((row) => row.uid), Array.from({ length: total }, (_, index) => index + 1));
	assert.ok(seen.maxParams <= 100, `a statement bound ${seen.maxParams} parameters`);
	assert.ok(seen.maxBatch <= SYNC_STEP * 4 + 10, `a batch held ${seen.maxBatch} statements`);
	// A reconcile of the same size stays inside the limits too.
	sqlite.prepare("DELETE FROM imap_mailbox_state").run();
	sqlite.prepare("DELETE FROM imap_uids").run();
	sqlite.prepare("DELETE FROM imap_folder_state").run();
	await sync();
	assert.equal(uids().length, total);
	assert.ok(seen.maxParams <= 100);
	assert.ok(seen.maxBatch <= SYNC_STEP * 4 + 10);
});

test("state follows the mailbox and the message: deleting either cascades", async (t) => {
	const { add, sqlite, sync } = await fixture(t);
	const id = add();
	await sync();
	sqlite.prepare("INSERT INTO imap_message_flags (message_id, answered) VALUES (?, 1)").run(id);
	sqlite.prepare("INSERT INTO imap_message_cache (message_id, size, envelope, bodystructure, header_size) VALUES (?, 1, '{}', '{}', 1)").run(id);
	sqlite.prepare("DELETE FROM messages WHERE id = ?").run(id);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM imap_message_flags").get().n, 0);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM imap_message_cache").get().n, 0);
	sqlite.prepare("DELETE FROM mailboxes WHERE id = 'm1'").run();
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM imap_mailbox_state").get().n, 0);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM imap_folder_state").get().n, 0);
});


/**
 * Looks at the database after every committed batch, the way a second connection would, and records anything a
 * client could not live with: a UID or mod-sequence that appears below one that was already visible, a counter
 * that goes down, a UIDVALIDITY that changes.
 */
function watchCommits(sqlite, seen) {
	const violations = [];
	const everUid = new Map();
	let everModseq = 0;
	let previous = { uids: new Map(), folders: new Map(), mailbox: 0 };
	seen.afterBatch = () => {
		const uids = new Map(sqlite.prepare("SELECT folder_key, uid, message_id, modseq FROM imap_uids").all().map((row) => [`${row.folder_key}:${row.uid}`, row]));
		const folders = new Map(sqlite.prepare("SELECT folder_key, uidvalidity, uid_next, highest_modseq FROM imap_folder_state").all().map((row) => [row.folder_key, row]));
		const mailbox = sqlite.prepare("SELECT modseq FROM imap_mailbox_state WHERE mailbox_id = 'm1'").get()?.modseq ?? 0;
		const expunged = sqlite.prepare("SELECT COALESCE(max(modseq), 0) AS top FROM imap_expunged").get().top;
		for (const [key, row] of uids) {
			const old = previous.uids.get(key);
			if (!old && row.uid <= (everUid.get(row.folder_key) ?? 0)) violations.push(`${key} appeared below UID ${everUid.get(row.folder_key)}`);
			if ((!old || old.modseq !== row.modseq) && row.modseq <= everModseq) violations.push(`${key} got modseq ${row.modseq} at or below ${everModseq}`);
		}
		for (const row of uids.values()) everUid.set(row.folder_key, Math.max(everUid.get(row.folder_key) ?? 0, row.uid));
		for (const row of uids.values()) everModseq = Math.max(everModseq, row.modseq);
		everModseq = Math.max(everModseq, expunged);
		for (const [key, row] of folders) {
			const old = previous.folders.get(key);
			if (!old) continue;
			if (row.uid_next < old.uid_next) violations.push(`${key} uid_next went down`);
			if (row.highest_modseq < old.highest_modseq) violations.push(`${key} highest_modseq went down`);
			if (row.uidvalidity !== old.uidvalidity) violations.push(`${key} uidvalidity changed`);
		}
		if (mailbox < previous.mailbox) violations.push("mailbox modseq went down");
		previous = { uids, folders, mailbox };
	};
	return violations;
}

test("UIDs and mod-sequences are reserved inside the batch that uses them, never ahead of it", async (t) => {
	const { add, sync, seen, sqlite, uids } = await fixture(t);
	await sync();
	for (let index = 0; index < 4; index += 1) add();
	await sync();
	sqlite.prepare("UPDATE messages SET starred = 1 WHERE id = ?").run(uids()[0].message_id);
	sqlite.prepare("DELETE FROM messages WHERE id = ?").run(uids()[1].message_id);
	await sync();
	const counter = /uid_next = uid_next \+|modseq = modseq \+/;
	assert.deepEqual(seen.runs.filter((query) => counter.test(query)), [], "a counter was bumped outside a batch");
	const writing = seen.batches.filter((batch) => batch.sqls.some((query) => /^(INSERT INTO imap_(uids|expunged)|UPDATE imap_uids)/.test(query)));
	assert.ok(writing.length >= 2);
	for (const batch of writing) assert.match(batch.sqls[0], /^UPDATE imap_mailbox_state SET modseq = modseq \+ \?/, "the mailbox row is locked first");
});

test("numbers bumped by another writer before our batch runs are not reused", async (t) => {
	const { add, sqlite, uids, sync, seen, mailboxState, folderState } = await fixture(t);
	await sync();
	add();
	add();
	let done = false;
	seen.beforeBatch = () => {
		if (done) return;
		done = true;
		// Another process takes 5 UIDs and 5 mod-sequences, with rows, and commits.
		sqlite.prepare("UPDATE imap_folder_state SET uid_next = uid_next + 5 WHERE id = 'm1:inbox'").run();
		sqlite.prepare("UPDATE imap_mailbox_state SET modseq = modseq + 5 WHERE mailbox_id = 'm1'").run();
	};
	await sync();
	seen.beforeBatch = null;
	assert.ok(done);
	assert.deepEqual(uids().map((row) => row.uid), [6, 7], "UIDs 1-5 belong to the other writer");
	assert.ok(uids()[0].modseq >= 7, `modseq ${uids()[0].modseq} overlaps the other writer's block`);
	assert.ok(mailboxState().modseq >= uids()[1].modseq);
	assert.equal(folderState().uid_next, 8);
});

test("a writer that planned before another one committed rolls back and follows it in order", async (t) => {
	const { add, sqlite, uids, sync, seen, folderState, expunged } = await fixture(t);
	await sync();
	const before = folderState();
	for (let index = 0; index < 3; index += 1) add();
	const violations = watchCommits(sqlite, seen);
	let injected = false;
	seen.beforeBatch = async () => {
		if (injected) return;
		injected = true;
		// Writer B syncs the same backlog, plus a newer message, and commits before writer A's batch runs.
		add();
		await syncMailboxUnserialized(seen.env, "m1");
	};
	await syncMailboxUnserialized(seen.env, "m1");
	assert.ok(injected);
	assert.deepEqual(violations, []);
	assert.deepEqual(uids().map((row) => row.uid), [1, 2, 3, 4], "no numbers wasted by the writer that lost");
	assert.deepEqual(uids().map((row) => row.modseq), [...uids().map((row) => row.modseq)].sort((a, b) => a - b));
	assert.equal(new Set(uids().map((row) => row.modseq)).size, 4);
	assert.equal(folderState().uidvalidity, before.uidvalidity, "no reset");
	assert.equal(folderState().uid_next, 5);
	assert.equal(expunged().length, 0);
});

test("three writers racing over a multi-step backlog keep commit order", async (t) => {
	const { add, sqlite, uids, seen, folderState, env } = await fixture(t);
	await syncMailboxUnserialized(env, "m1");
	const before = folderState();
	const total = SYNC_STEP * 2 + 9;
	for (let index = 0; index < total; index += 1) add();
	const violations = watchCommits(sqlite, seen);
	await Promise.all([syncMailboxUnserialized(env, "m1"), syncMailboxUnserialized(env, "m1"), syncMailboxUnserialized(env, "m1")]);
	assert.deepEqual(violations, []);
	assert.deepEqual(uids().map((row) => row.uid), Array.from({ length: total }, (_, index) => index + 1));
	assert.equal(folderState().uidvalidity, before.uidvalidity);
});

test("harmless contention between the uid_next read and the max(uid) read does not reset the folder", async (t) => {
	const { add, sqlite, uids, sync, seen, folderState } = await fixture(t);
	add();
	await sync();
	const before = folderState().uidvalidity;
	add();
	let done = false;
	seen.beforeAll = (query) => {
		if (done || !/SELECT max\(uid\) AS top FROM imap_uids/.test(query)) return;
		done = true;
		// Another writer reserves UID 2 and commits its row, just as the consistency check looks.
		sqlite.prepare("UPDATE imap_folder_state SET uid_next = uid_next + 1 WHERE id = 'm1:inbox'").run();
		sqlite.prepare("INSERT INTO imap_uids (mailbox_id, folder_key, uid, message_id, modseq) VALUES ('m1', 'inbox', 2, 'other', 99)").run();
	};
	await new Promise((resolve) => setTimeout(resolve, 1100));
	await sync();
	seen.beforeAll = null;
	assert.ok(done, "the other writer ran");
	assert.equal(folderState().uidvalidity, before, "no reset");
	assert.deepEqual(uids().map((row) => row.uid), [1, 2, 3]);
});

test("a suspected inconsistency is read again under the lock before the folder is reset", async (t) => {
	const { add, sqlite, uids, sync, seen, folderState } = await fixture(t);
	add();
	await sync();
	const before = folderState().uidvalidity;
	sqlite.prepare("UPDATE imap_folder_state SET uid_next = 1 WHERE id = 'm1:inbox'").run();
	add();
	let repaired = false;
	seen.beforeBatch = (queries) => {
		if (repaired || !queries.some((query) => /^SELECT max\(uid\)/.test(query))) return;
		repaired = true;
		sqlite.prepare("UPDATE imap_folder_state SET uid_next = 10 WHERE id = 'm1:inbox'").run();
	};
	await new Promise((resolve) => setTimeout(resolve, 1100));
	await sync();
	seen.beforeBatch = null;
	assert.ok(repaired, "the locked re-read ran");
	assert.equal(folderState().uidvalidity, before, "the folder was not reset");
	assert.deepEqual(uids().map((row) => row.uid), [1, 10]);
});

test("a reconcile positions the mailbox at its own last change, not the shared log's", async (t) => {
	const { add, sqlite, sync, mailboxState } = await fixture(t);
	add();
	add({ mailbox_id: "m2" });
	add({ mailbox_id: "m2" });
	add({ mailbox_id: "m2" });
	const own = sqlite.prepare("SELECT max(seq) AS seq FROM jmap_changes WHERE mailbox_id = 'm1'").get().seq;
	const shared = sqlite.prepare("SELECT max(seq) AS seq FROM jmap_changes").get().seq;
	assert.ok(shared > own, "the other mailbox has later changes");
	await sync();
	assert.equal(mailboxState().jmap_seq, own);
});

test("a floor reconcile replaces a draft whose content changed and keeps one that did not", async (t) => {
	const { add, sqlite, uids, sync, expunged } = await fixture(t);
	const changed = add({ status: "draft", direction: "outbound", subject: "Hello", text_body: "v1" });
	const same = add({ status: "draft", direction: "outbound", subject: "Other", text_body: "same" });
	await sync();
	sqlite.prepare("INSERT INTO imap_message_cache (message_id, size, envelope, bodystructure, header_size) VALUES (?, 1, '{}', '{}', 1)").run(changed);
	sqlite.prepare("INSERT INTO imap_message_cache (message_id, size, envelope, bodystructure, header_size) VALUES (?, 1, '{}', '{}', 1)").run(same);
	const first = Object.fromEntries(uids("drafts").map((row) => [row.message_id, row.uid]));
	sqlite.prepare("UPDATE messages SET text_body = 'v2' WHERE id = ?").run(changed);
	const top = sqlite.prepare("SELECT max(seq) AS seq FROM jmap_changes").get().seq;
	sqlite.prepare("DELETE FROM jmap_changes").run();
	sqlite.prepare("UPDATE jmap_change_floor SET seq = ? WHERE id = 1").run(top);
	await sync();
	const after = Object.fromEntries(uids("drafts").map((row) => [row.message_id, row.uid]));
	assert.equal(after[same], first[same], "an unchanged draft keeps its UID");
	assert.ok(after[changed] > first[changed], "an edited draft gets a new UID");
	assert.deepEqual(expunged("drafts").map((row) => row.uid), [first[changed]]);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM imap_message_cache WHERE message_id = ?").get(changed).n, 0);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM imap_message_cache WHERE message_id = ?").get(same).n, 1);
});

test("changes pruned between two slices send the sync to a full reconcile instead of dropping them", async (t) => {
	const { add, sqlite, uids, sync, seen, expunged } = await fixture(t);
	const stale = add();
	await sync();
	const total = SYNC_STEP + 20;
	for (let index = 0; index < total; index += 1) add();
	sqlite.prepare("DELETE FROM messages WHERE id = ?").run(stale);
	let reads = 0;
	seen.beforeAll = (query) => {
		if (!/FROM jmap_changes WHERE mailbox_id/.test(query) || ++reads !== 2) return;
		// After the first slice was applied, the retention job drops everything that is left.
		const top = sqlite.prepare("SELECT max(seq) AS seq FROM jmap_changes").get().seq;
		sqlite.prepare("DELETE FROM jmap_changes").run();
		sqlite.prepare("UPDATE jmap_change_floor SET seq = ? WHERE id = 1").run(top);
	};
	await sync();
	seen.beforeAll = null;
	assert.ok(reads >= 2, "the second slice was read");
	assert.equal(uids().length, total, "every message has a UID");
	assert.deepEqual(expunged().map((row) => row.uid), [1], "the deleted message is expunged");
});

test("changes pruned just before the first slice is read are not lost either", async (t) => {
	const { add, sqlite, uids, sync, seen } = await fixture(t);
	const keep = add();
	await sync();
	const fresh = add();
	let done = false;
	seen.beforeAll = (query) => {
		if (done || !/FROM jmap_changes WHERE mailbox_id/.test(query)) return;
		done = true;
		const top = sqlite.prepare("SELECT max(seq) AS seq FROM jmap_changes").get().seq;
		sqlite.prepare("DELETE FROM jmap_changes").run();
		sqlite.prepare("UPDATE jmap_change_floor SET seq = ? WHERE id = 1").run(top);
	};
	await sync();
	seen.beforeAll = null;
	assert.ok(done);
	assert.deepEqual(uids().map((row) => row.message_id), [keep, fresh]);
});

test("the mod-sequence bump of a floor reconcile runs in bounded statements", async (t) => {
	const { add, sqlite, uids, sync, seen, folderState, mailboxState } = await fixture(t);
	const total = BUMP_CHUNK * 2 + 40;
	sqlite.exec("BEGIN");
	for (let index = 0; index < total; index += 1) add();
	sqlite.exec("COMMIT");
	await sync();
	const before = uids();
	assert.equal(before.length, total);
	sqlite.prepare("UPDATE messages SET starred = 1 WHERE id = ?").run(before[0].message_id);
	const top = sqlite.prepare("SELECT max(seq) AS seq FROM jmap_changes").get().seq;
	sqlite.prepare("DELETE FROM jmap_changes").run();
	sqlite.prepare("UPDATE jmap_change_floor SET seq = ? WHERE id = 1").run(top);
	seen.batches.length = 0;
	await sync();
	const after = uids();
	assert.equal(after.length, total);
	assert.ok(after.every((row, index) => row.modseq > before[index].modseq), "every UID announces a new modseq");
	const widest = Math.max(...seen.batches.flatMap((batch) => batch.sqls.flatMap((query, index) => (/^UPDATE imap_uids SET modseq/.test(query) ? [batch.changes[index]] : []))));
	assert.ok(widest > 0 && widest <= BUMP_CHUNK, `one statement changed ${widest} rows`);
	assert.equal(folderState().highest_modseq, Math.max(...after.map((row) => row.modseq)));
	assert.ok(mailboxState().modseq >= folderState().highest_modseq);
});

/**
 * Plays a second writer: right before the first batch that matches `pattern` commits, `intervene` runs
 * (and may sync the same mailbox to completion), so the plan of the batch about to run is stale.
 */
function interveneOnce(seen, pattern, intervene) {
	let injected = false;
	seen.beforeBatch = async (sqls) => {
		if (injected || !sqls.some((query) => pattern.test(query))) return;
		injected = true;
		await intervene();
	};
}

const foldersOf = (sqlite, id) => sqlite.prepare("SELECT folder_key FROM imap_uids WHERE message_id = ? ORDER BY folder_key").all(id).map((row) => row.folder_key);

test("a stale plan that hits no unique index cannot leave a UID for a message that moved away", async (t) => {
	const { add, sqlite, uids, sync, seen, env } = await fixture(t);
	await sync();
	const m = add();
	interveneOnce(seen, /^INSERT INTO imap_uids/, async () => {
		sqlite.prepare("UPDATE messages SET status = 'archived' WHERE id = ?").run(m);
		await syncMailboxUnserialized(env, "m1");
	});
	await syncMailboxUnserialized(env, "m1");
	seen.beforeBatch = null;
	await syncMailboxUnserialized(env, "m1");
	assert.equal(uids("inbox").length, 0, "no UID in the inbox for an archived message");
	assert.deepEqual(foldersOf(sqlite, m), ["archive"]);
});

test("a stale plan cannot expunge the UID of a message that came back", async (t) => {
	const { add, sqlite, sync, seen, env, uids, expunged } = await fixture(t);
	const m = add();
	await sync();
	sqlite.prepare("UPDATE messages SET status = 'archived' WHERE id = ?").run(m);
	interveneOnce(seen, /^DELETE FROM imap_uids/, async () => {
		sqlite.prepare("UPDATE messages SET status = 'received' WHERE id = ?").run(m);
		await syncMailboxUnserialized(env, "m1");
	});
	await syncMailboxUnserialized(env, "m1");
	seen.beforeBatch = null;
	await syncMailboxUnserialized(env, "m1");
	assert.deepEqual(foldersOf(sqlite, m), ["inbox"]);
	assert.deepEqual(uids("inbox").map((row) => row.uid), [1], "the UID the client knows is still there");
	assert.equal(expunged("inbox").length, 0);
});

test("a stale reconcile cannot assign a UID to a message that left the folder meanwhile", async (t) => {
	const { add, sqlite, sync, seen, env, uids } = await fixture(t);
	const m = add();
	interveneOnce(seen, /^INSERT INTO imap_uids/, async () => {
		sqlite.prepare("UPDATE messages SET status = 'archived' WHERE id = ?").run(m);
		await syncMailboxUnserialized(env, "m1");
	});
	await syncMailboxUnserialized(env, "m1");
	seen.beforeBatch = null;
	await sync();
	assert.equal(uids("inbox").length, 0);
	assert.deepEqual(foldersOf(sqlite, m), ["archive"]);
});

test("a stale reconcile cannot expunge a UID of a message that is back", async (t) => {
	const { add, sqlite, sync, seen, env, uids, expunged } = await fixture(t);
	const m = add();
	await sync();
	const top = sqlite.prepare("SELECT max(seq) AS seq FROM jmap_changes").get().seq;
	sqlite.prepare("DELETE FROM jmap_changes").run();
	sqlite.prepare("UPDATE jmap_change_floor SET seq = ? WHERE id = 1").run(top);
	sqlite.prepare("UPDATE messages SET status = 'archived' WHERE id = ?").run(m);
	interveneOnce(seen, /^INSERT INTO imap_expunged/, async () => {
		sqlite.prepare("UPDATE messages SET status = 'received' WHERE id = ?").run(m);
		await syncMailboxUnserialized(env, "m1");
	});
	await syncMailboxUnserialized(env, "m1");
	seen.beforeBatch = null;
	await sync();
	assert.deepEqual(uids("inbox").map((row) => row.uid), [1]);
	assert.equal(expunged("inbox").length, 0);
	assert.deepEqual(foldersOf(sqlite, m), ["inbox"]);
});

test("every write batch carries the guard right after the mailbox lock and removes its rows", async (t) => {
	const { add, sqlite, sync, seen } = await fixture(t);
	await sync();
	add();
	add();
	seen.batches.length = 0;
	await sync();
	assert.ok(seen.batches.length > 0);
	for (const batch of seen.batches) {
		assert.match(batch.sqls[0], /^UPDATE imap_mailbox_state SET modseq/);
		assert.match(batch.sqls[1], /^INSERT INTO imap_uids .*CASE WHEN/);
		assert.match(batch.sqls[batch.sqls.length - 1], /^DELETE FROM imap_uids WHERE mailbox_id = \? AND folder_key = \?$/);
	}
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM imap_uids WHERE folder_key LIKE 'guard:%'").get().n, 0);
});
