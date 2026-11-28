import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-trash-retention-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { runTrashRetention } from "./src/lib/email/trash-retention.ts";
			export { TRASH_RETENTION_BATCH_SIZE } from "./src/lib/email/trash-retention-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "trash-retention-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, runTrashRetention, TRASH_RETENTION_BATCH_SIZE } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const NOW = new Date("2026-03-01T00:00:00Z");
const DAY = 86_400;
const nowSeconds = Math.floor(NOW.getTime() / 1000);

async function setup(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const db = database.db;
	for (const [id, days] of [["u1", 7], ["u2", 30], ["u3", null]]) {
		db.prepare("INSERT INTO users (id, email, name, password_hash, trash_retention_days, created_at) VALUES (?, ?, ?, 'x', ?, 1)").run(id, `${id}@example.com`, id, days);
		db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES (?, ?, ?, 'zone', 1)").run(`d-${id}`, id, `${id}.example.com`);
		db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES (?, ?, ?, 'me', 'primary', 1)").run(`mb-${id}`, id, `d-${id}`);
	}
	const deleted = [];
	const bucket = {
		// R2 accepts one key or a list.
		delete: async (key) => { deleted.push(...[key].flat()); },
		head: async () => null,
		get: async () => null,
		list: async () => ({ objects: [], truncated: false }),
	};
	const env = { DB: database, BUCKET: bucket };
	// A trigger stamps trashed_at on insert, so the age is written afterwards.
	const addMessage = (id, user, status, daysAgo, rawKey = `raw/${id}`) => {
		db.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, raw_r2_key, created_at) VALUES (?, ?, ?, 'inbound', 'a@example.net', ?, ?, ?, 1)")
			.run(id, user, `mb-${user}`, `${user}@example.com`, status, rawKey);
		db.prepare("UPDATE messages SET trashed_at = ? WHERE id = ?").run(nowSeconds - Math.round(daysAgo * DAY), id);
	};
	const remaining = () => db.prepare("SELECT id FROM messages ORDER BY id").all().map((row) => row.id);
	return { env, db, deleted, addMessage, remaining };
}

test("deletes only trash and spam messages older than the owner's cutoff", async (t) => {
	const { env, deleted, addMessage, remaining } = await setup(t);
	addMessage("old-trash", "u1", "trash", 8);
	addMessage("old-spam", "u1", "spam", 8);
	addMessage("new-trash", "u1", "trash", 6);
	addMessage("old-received", "u1", "received", 8);
	assert.equal(await runTrashRetention(env, NOW), 2);
	assert.deepEqual(remaining(), ["new-trash", "old-received"]);
	assert.deepEqual(deleted.sort(), ["raw/old-spam", "raw/old-trash"]);
});

test("uses each owner's own retention days and skips owners without one", async (t) => {
	const { env, addMessage, remaining } = await setup(t);
	addMessage("u2-new", "u2", "trash", 10);
	addMessage("u2-old", "u2", "trash", 31);
	addMessage("u3-old", "u3", "trash", 400);
	assert.equal(await runTrashRetention(env, NOW), 1);
	assert.deepEqual(remaining(), ["u2-new", "u3-old"]);
});

test("writes one audit row per deleted message", async (t) => {
	const { env, db, addMessage } = await setup(t);
	addMessage("a", "u1", "trash", 8);
	addMessage("b", "u1", "spam", 9);
	await runTrashRetention(env, NOW);
	const rows = db.prepare("SELECT action, metadata FROM audit_logs ORDER BY id").all();
	assert.equal(rows.length, 2);
	for (const row of rows) assert.equal(row.action, "email.delete");
	const metadata = rows.map((row) => JSON.parse(row.metadata));
	for (const item of metadata) {
		assert.equal(item.permanent, true);
		assert.equal(item.source, "retention");
	}
	assert.deepEqual(metadata.map((item) => item.messageId).sort(), ["a", "b"]);
});

test("removes at most one batch per run and drains the rest next run", async (t) => {
	const { env, db, addMessage } = await setup(t);
	db.exec("BEGIN");
	for (let index = 0; index < TRASH_RETENTION_BATCH_SIZE + 5; index += 1) addMessage(`m${index}`, "u1", "trash", 8);
	db.exec("COMMIT");
	assert.equal(await runTrashRetention(env, NOW), TRASH_RETENTION_BATCH_SIZE);
	assert.equal(await runTrashRetention(env, NOW), 5);
	assert.equal(await runTrashRetention(env, NOW), 0);
});

test("returns 0 and touches nothing when no owner has retention on", async (t) => {
	const { env, db, deleted, addMessage, remaining } = await setup(t);
	db.exec("UPDATE users SET trash_retention_days = NULL");
	addMessage("old", "u1", "trash", 400);
	assert.equal(await runTrashRetention(env, NOW), 0);
	assert.deepEqual(deleted, []);
	assert.deepEqual(remaining(), ["old"]);
});
