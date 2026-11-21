import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(process.env.TMPDIR ?? root, "mailflare-imap-condstore-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { syncMailbox } from "./src/lib/imap/sync.ts";
			export { pruneImapExpunged, EXPUNGED_RETENTION_SECONDS } from "./src/lib/imap/expunge-prune.ts";
			export { FolderView } from "./src/lib/imap/view.ts";
			export { parseModseq, subtractPresent, formatRanges, vanishedSince, changedSince, modseqsOf, folderModseqs } from "./src/lib/imap/condstore.ts";
		`,
		resolveDir: root,
		sourcefile: "imap-condstore-test-entry.ts",
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
const { SqliteDatabase, applyMigrations, syncMailbox, pruneImapExpunged, EXPUNGED_RETENTION_SECONDS, FolderView, parseModseq, subtractPresent, formatRanges, vanishedSince, changedSince, modseqsOf, folderModseqs } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

async function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const sqlite = database.db;
	sqlite.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('u1', 'u1@example.test', 'x', 'U', 'user', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.test', 'z', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('m1', 'u1', 'd1', 'me', 1);
	`);
	const env = { DB: database };
	let clock = 1000;
	let counter = 0;
	const add = (overrides = {}) => {
		const id = overrides.id ?? `g${++counter}`;
		const row = { user_id: "u1", mailbox_id: "m1", direction: "inbound", from_addr: "a@b.test", to_addr: "me@example.test", status: "received", subject: "s", text_body: "t", html_body: null, created_at: ++clock, ...overrides, id };
		const names = Object.keys(row);
		sqlite.prepare(`INSERT INTO messages (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...Object.values(row));
		return id;
	};
	const sync = () => syncMailbox(env, "m1");
	const expunged = (folder = "inbox") => sqlite.prepare("SELECT uid, modseq, created_at FROM imap_expunged WHERE mailbox_id = 'm1' AND folder_key = ? ORDER BY uid").all(folder);
	const floor = (folder = "inbox") => sqlite.prepare("SELECT expunged_floor FROM imap_folder_state WHERE id = ?").get(`m1:${folder}`).expunged_floor;
	/** Adds `count` messages, syncs, deletes them and syncs again: that many expunge rows. */
	const expungeSome = async (count, folder = "inbox", overrides = {}) => {
		const ids = Array.from({ length: count }, () => add(overrides));
		await sync();
		for (const id of ids) sqlite.prepare("DELETE FROM messages WHERE id = ?").run(id);
		await sync();
		return ids;
	};
	return { database, sqlite, env, add, sync, expunged, floor, expungeSome };
}

const NOW = new Date("2030-01-01T00:00:00Z");
const nowSeconds = Math.floor(NOW.getTime() / 1000);
const old = nowSeconds - EXPUNGED_RETENTION_SECONDS - 10;

test("prune deletes expunge rows older than 30 days, keeps newer ones and records the floor", async (t) => {
	const { sqlite, env, expungeSome, expunged, floor } = await fixture(t);
	await expungeSome(3);
	const rows = expunged();
	assert.equal(rows.length, 3);
	assert.equal(floor(), 0, "nothing pruned yet");
	sqlite.prepare("UPDATE imap_expunged SET created_at = ? WHERE uid IN (1, 2)").run(old);
	sqlite.prepare("UPDATE imap_expunged SET created_at = ? WHERE uid = 3").run(nowSeconds - 60);
	const removed = await pruneImapExpunged(env, NOW);
	assert.equal(removed, 2);
	assert.deepEqual(expunged().map((row) => row.uid), [3]);
	assert.equal(floor(), Math.max(rows[0].modseq, rows[1].modseq), "the floor is the highest modseq that was dropped");
	assert.equal(await pruneImapExpunged(env, NOW), 0, "nothing left to do");
	assert.equal(floor(), Math.max(rows[0].modseq, rows[1].modseq), "and the floor stays");
});

test("a newer row with a lower modseq than a dropped one goes too, so the floor stays exact", async (t) => {
	const { sqlite, env, expungeSome, expunged, floor } = await fixture(t);
	await expungeSome(3);
	const rows = expunged();
	// Clocks can disagree between writers: the row with the highest modseq looks old, the others look new.
	sqlite.prepare("UPDATE imap_expunged SET created_at = ? WHERE uid = 3").run(old);
	sqlite.prepare("UPDATE imap_expunged SET created_at = ? WHERE uid IN (1, 2)").run(nowSeconds);
	await pruneImapExpunged(env, NOW);
	assert.deepEqual(expunged(), [], "nothing at or below the floor is kept: a reader could not tell it was complete");
	assert.equal(floor(), rows[2].modseq);
});

test("pruning one folder leaves another folder's rows and floor alone, and rows without folder state go too", async (t) => {
	const { sqlite, env, expungeSome, expunged, floor } = await fixture(t);
	await expungeSome(1);
	await expungeSome(1, "archive", { status: "archived" });
	sqlite.prepare("UPDATE imap_expunged SET created_at = ? WHERE folder_key = 'inbox'").run(old);
	sqlite.prepare("UPDATE imap_expunged SET created_at = ? WHERE folder_key = 'archive'").run(nowSeconds);
	sqlite.prepare("INSERT INTO imap_expunged (mailbox_id, folder_key, uid, modseq, created_at) VALUES ('gone', 'inbox', 4, 9, ?)").run(old);
	assert.equal(await pruneImapExpunged(env, NOW), 2);
	assert.equal(expunged().length, 0);
	assert.equal(expunged("archive").length, 1);
	assert.ok(floor() > 0);
	assert.equal(floor("archive"), 0);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM imap_expunged WHERE mailbox_id = 'gone'").get().n, 0, "rows of a deleted mailbox are not kept forever");
});

test("a prune batch starts with the statement a sync starts with, so the two take the mailbox lock in the same order", async (t) => {
	const { sqlite, database, env, expungeSome } = await fixture(t);
	await expungeSome(1);
	sqlite.prepare("UPDATE imap_expunged SET created_at = ?").run(old);
	const batches = [];
	const batch = database.batch.bind(database);
	database.batch = (statements) => {
		batches.push(statements.map((statement) => statement.sql));
		return batch(statements);
	};
	assert.equal(await pruneImapExpunged(env, NOW), 1);
	assert.equal(batches.length, 1);
	assert.equal(batches[0][0], "UPDATE imap_mailbox_state SET modseq = modseq WHERE mailbox_id = ?");
});

test("the prune finds the old rows through an index on their age", async (t) => {
	const { sqlite } = await fixture(t);
	const plan = sqlite.prepare("EXPLAIN QUERY PLAN SELECT mailbox_id, folder_key, modseq FROM imap_expunged WHERE created_at < ? ORDER BY created_at LIMIT ?").all(1, 100).map((row) => row.detail).join("\n");
	assert.match(plan, /USING (COVERING )?INDEX imap_expunged_created_idx/);
});

test("the floor never goes down, and many folders are pruned in several rounds", async (t) => {
	const { sqlite, env, expungeSome, floor } = await fixture(t);
	await expungeSome(2);
	sqlite.prepare("UPDATE imap_expunged SET created_at = ?").run(old);
	await pruneImapExpunged(env, NOW);
	const first = floor();
	sqlite.prepare("UPDATE imap_folder_state SET expunged_floor = ? WHERE id = 'm1:inbox'").run(first + 100);
	await expungeSome(1);
	sqlite.prepare("UPDATE imap_expunged SET created_at = ?").run(old);
	await pruneImapExpunged(env, NOW);
	assert.equal(floor(), first + 100, "a higher floor is kept");
	for (let index = 0; index < 250; index += 1) sqlite.prepare("INSERT INTO imap_expunged (mailbox_id, folder_key, uid, modseq, created_at) VALUES (?, 'inbox', 1, 5, ?)").run(`orphan${index}`, old);
	assert.equal(await pruneImapExpunged(env, NOW), 250, "more groups than one round holds are all reached");
});

// ---- Mod-sequence helpers ----

test("parseModseq accepts 0 and digits, clamps what a number cannot hold, and refuses the rest", () => {
	assert.equal(parseModseq("0"), 0);
	assert.equal(parseModseq("123"), 123);
	assert.equal(parseModseq("9223372036854775807"), Number.MAX_SAFE_INTEGER, "beyond anything this server has handed out");
	for (const bad of ["", "-1", "1.5", "abc", "12a", "+5", "99999999999999999999", " 5"]) assert.equal(parseModseq(bad), null, JSON.stringify(bad));
});

test("subtractPresent removes the UIDs that exist from the ranges and keeps the rest as ranges", () => {
	assert.deepEqual(subtractPresent([[1, 10]], [2, 3, 7]), [[1, 1], [4, 6], [8, 10]]);
	assert.deepEqual(subtractPresent([[1, 5]], [1, 2, 3, 4, 5]), []);
	assert.deepEqual(subtractPresent([[3, 4], [8, 20]], [4, 10, 11]), [[3, 3], [8, 9], [12, 20]]);
	assert.deepEqual(subtractPresent([[5, 4]], []), [], "an empty range stays empty");
	assert.deepEqual(subtractPresent([[1, 4_000_000_000]], [5]), [[1, 4], [6, 4_000_000_000]], "the size of a range costs nothing");
	assert.equal(formatRanges([[1, 1], [4, 6], [8, 10]]), "1,4:6,8:10");
});

async function openView(env) {
	return FolderView.open(env, "m1", "inbox");
}

test("vanishedSince lists the UIDs expunged after a mod-sequence, from the rows that are kept", async (t) => {
	const { sqlite, env, add, sync } = await fixture(t);
	const ids = [add(), add(), add(), add(), add()];
	await sync();
	const before = sqlite.prepare("SELECT highest_modseq FROM imap_folder_state WHERE id = 'm1:inbox'").get().highest_modseq;
	sqlite.prepare("DELETE FROM messages WHERE id = ?").run(ids[1]);
	await sync();
	const middle = sqlite.prepare("SELECT highest_modseq FROM imap_folder_state WHERE id = 'm1:inbox'").get().highest_modseq;
	sqlite.prepare("DELETE FROM messages WHERE id = ?").run(ids[3]);
	await sync();
	const view = await openView(env);
	assert.deepEqual(await vanishedSince(env, view, before, null), [[2, 2], [4, 4]]);
	assert.deepEqual(await vanishedSince(env, view, middle, null), [[4, 4]], "only what vanished after that point");
	assert.deepEqual(await vanishedSince(env, view, view.highest, null), []);
	assert.deepEqual(await vanishedSince(env, view, before, [[3, 100]]), [[4, 4]], "limited to the UIDs the client asked about");
});

test("below the floor the answer is computed from the UIDs that exist, and stays exact", async (t) => {
	const { sqlite, env, add, sync, floor } = await fixture(t);
	const ids = [add(), add(), add(), add(), add()];
	await sync();
	const start = sqlite.prepare("SELECT highest_modseq FROM imap_folder_state WHERE id = 'm1:inbox'").get().highest_modseq;
	sqlite.prepare("DELETE FROM messages WHERE id IN (?, ?)").run(ids[1], ids[3]);
	await sync();
	sqlite.prepare("UPDATE imap_expunged SET created_at = ?").run(old);
	await pruneImapExpunged(env, NOW);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM imap_expunged").get().n, 0, "the rows are gone");
	assert.ok(floor() > start);
	sqlite.prepare("DELETE FROM messages WHERE id = ?").run(ids[4]);
	await sync();
	const view = await openView(env);
	assert.deepEqual(await vanishedSince(env, view, start, [[1, 5]]), [[2, 2], [4, 5]], "what was pruned and what was not");
	assert.deepEqual(await vanishedSince(env, view, start, null), [[2, 2], [4, 5]], "no list of known UIDs: every UID ever assigned that is gone");
	assert.deepEqual(await vanishedSince(env, view, start, [[3, 4]]), [[4, 4]]);
	assert.deepEqual(await vanishedSince(env, view, start, [[1, 100]]), [[2, 2], [4, 5]], "UIDs never assigned are not reported");
	// At or above the floor the kept rows are complete.
	assert.deepEqual(await vanishedSince(env, view, floor(), null), [[5, 5]]);
});

test("changedSince and modseqsOf read the mod-sequences of the folder", async (t) => {
	const { sqlite, env, add, sync } = await fixture(t);
	const ids = [add(), add(), add()];
	await sync();
	const since = sqlite.prepare("SELECT highest_modseq FROM imap_folder_state WHERE id = 'm1:inbox'").get().highest_modseq;
	sqlite.prepare("UPDATE messages SET starred = ? WHERE id = ?").run(1, ids[1]);
	await sync();
	assert.deepEqual([...(await changedSince(env, "m1", "inbox", since))], [2]);
	assert.deepEqual([...(await changedSince(env, "m1", "inbox", 0))].sort(), [1, 2, 3]);
	const all = await folderModseqs(env, "m1", "inbox");
	assert.equal(all.size, 3);
	assert.ok(all.get(2) > since && all.get(1) <= since);
	assert.deepEqual([...(await modseqsOf(env, "m1", "inbox", [2, 3, 99])).keys()].sort(), [2, 3]);
	const many = await modseqsOf(env, "m1", "inbox", Array.from({ length: 250 }, (_, index) => index + 1));
	assert.equal(many.size, 3, "chunked lookups give the same answer");
});
