import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-folder-retention-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		retention: join(root, "src/lib/email/trash-retention.ts"),
		utils: join(root, "src/lib/email/trash-retention-utils.ts"),
		database: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*", "postal-mime", "cloudflare:workers"],
	logLevel: "silent",
});

const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { runTrashRetention } = await load("retention");
const { TRASH_RETENTION_BATCH_SIZE } = await load("utils");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

const DAY = 86_400_000;
const NOW = new Date("2026-11-20T09:00:00Z");
const daysAgo = (days) => Math.floor(new Date(NOW.getTime() - days * DAY).getTime() / 1000);

/** A migrated SQLite database, one mailbox owner (u1) plus a second account (u2) with no rules. */
async function fixture(t) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));

	const db = database.db;
	const created = daysAgo(400);
	db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'one@example.com', 'One', 'x', ?)").run(created);
	db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u2', 'two@example.com', 'Two', 'x', ?)").run(created);
	db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d1', 'u1', 'example.com', 'z', 'active', ?)").run(created);
	db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d2', 'u2', 'other.example', 'z', 'active', ?)").run(created);
	db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb1', 'u1', 'd1', 'one', ?)").run(created);
	db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb2', 'u2', 'd2', 'two', ?)").run(created);

	const addFolder = (id, userId, mailboxId, retentionDays) => {
		db.prepare("INSERT INTO folders (id, user_id, mailbox_id, name, color, retention_days, created_at) VALUES (?, ?, ?, ?, '#2563eb', ?, ?)").run(id, userId, mailboxId, id, retentionDays, created);
	};
	const files = [];
	const env = { DB: database, BUCKET: { delete: async (keys) => void files.push(...(Array.isArray(keys) ? keys : [keys])) } };

	const insertMessage = (id, { userId = "u1", mailboxId = "mb1", folderId = null, status = "received", created = 10, trashed = null, rawR2Key = null } = {}) => {
		db.prepare("INSERT INTO messages (id, user_id, mailbox_id, folder_id, direction, from_addr, to_addr, status, created_at, raw_r2_key) VALUES (?, ?, ?, ?, 'inbound', 'news@letter.example', 'one@example.com', ?, ?, ?)")
			.run(id, userId, mailboxId, folderId, status, daysAgo(created), rawR2Key);
		// The insert trigger stamps trashed_at for trash/spam, so an explicit value is written afterwards.
		if (trashed !== null) db.prepare("UPDATE messages SET trashed_at = ? WHERE id = ?").run(daysAgo(trashed), id);
	};
	const setGlobalDays = (userId, days) => db.prepare("UPDATE users SET trash_retention_days = ? WHERE id = ?").run(days, userId);
	const ids = () => db.prepare("SELECT id FROM messages ORDER BY id").all().map((row) => row.id);
	const count = () => db.prepare("SELECT count(*) AS n FROM messages").get().n;
	const auditRetention = () => db.prepare("SELECT count(*) AS n FROM audit_logs WHERE action = 'email.delete' AND metadata LIKE '%\"source\":\"retention\"%'").get().n;

	return { env, db, insertMessage, addFolder, setGlobalDays, ids, count, files, auditRetention };
}

test("a folder rule purges aged mail that is not in Trash, and only past its own window", async (t) => {
	const f = await fixture(t);
	f.addFolder("fld_news", "u1", "mb1", 7);
	f.insertMessage("old", { folderId: "fld_news", status: "received", created: 10, rawR2Key: "raw/old" });
	f.insertMessage("young", { folderId: "fld_news", status: "received", created: 3 });
	f.insertMessage("archived", { folderId: "fld_news", status: "archived", created: 30 });

	assert.equal(await runTrashRetention(f.env, NOW), 2);
	assert.deepEqual(f.ids(), ["young"]);
	assert.deepEqual(f.files, ["raw/old"], "the raw MIME object goes with the row");
	assert.equal(f.auditRetention(), 2, "each purge is audited with the retention source");
});

test("no folder rule means nothing outside Trash is touched, however old", async (t) => {
	const f = await fixture(t);
	f.addFolder("fld_plain", "u1", "mb1", null);
	f.insertMessage("very-old", { folderId: "fld_plain", status: "received", created: 365 });
	assert.equal(await runTrashRetention(f.env, NOW), 0);
	assert.deepEqual(f.ids(), ["very-old"]);
});

test("a folder rule works with no global Trash retention at all; the rule alone is enough", async (t) => {
	const f = await fixture(t);
	f.addFolder("fld_news", "u1", "mb1", 30);
	f.insertMessage("old", { folderId: "fld_news", created: 40 });
	assert.equal(await runTrashRetention(f.env, NOW), 1);
	assert.deepEqual(f.ids(), []);
});

test("the folder window decides, not the global one, for mail in a ruled folder", async (t) => {
	const f = await fixture(t);
	// The global rule is 90 days: on its own it would never remove a message received 20 days ago.
	f.setGlobalDays("u1", 90);
	f.addFolder("fld_news", "u1", "mb1", 7);
	f.insertMessage("old", { folderId: "fld_news", created: 20 });
	f.insertMessage("young", { folderId: "fld_news", created: 2 });
	assert.equal(await runTrashRetention(f.env, NOW), 1);
	assert.deepEqual(f.ids(), ["young"]);
});

test("folder rules age mail by createdAt, while Trash retention keeps using trashedAt", async (t) => {
	const f = await fixture(t);
	f.setGlobalDays("u1", 90);
	f.addFolder("fld_news", "u1", "mb1", 30);
	f.insertMessage("in-folder", { folderId: "fld_news", status: "trash", created: 40, trashed: 2 });
	f.insertMessage("plain-trash", { status: "trash", created: 40, trashed: 2 });
	assert.equal(await runTrashRetention(f.env, NOW), 1, "created 40 days ago is past the folder's 30 days");
	assert.deepEqual(f.ids(), ["plain-trash"], "the unfiled message is only 2 days into its 90-day Trash window");
});

test("a folder rule never touches drafts or mail the sending pipeline owns", async (t) => {
	const f = await fixture(t);
	f.addFolder("fld_news", "u1", "mb1", 7);
	for (const status of ["draft", "queued", "failed"]) f.insertMessage(status, { folderId: "fld_news", status, created: 90 });
	assert.equal(await runTrashRetention(f.env, NOW), 0);
	assert.deepEqual(f.ids(), ["draft", "failed", "queued"]);
});

test("a folder rule never reaches another account's mail", async (t) => {
	const f = await fixture(t);
	f.addFolder("fld_news", "u1", "mb1", 7);
	// Same folder id, different owner: only the folder's own owner is in scope.
	f.insertMessage("intruder", { userId: "u2", mailboxId: "mb2", folderId: "fld_news", created: 90 });
	assert.equal(await runTrashRetention(f.env, NOW), 0);
	assert.deepEqual(f.ids(), ["intruder"]);
});

test("deleting a folder hands its mail back to the global rule", async (t) => {
	const f = await fixture(t);
	f.setGlobalDays("u1", 7);
	f.addFolder("fld_news", "u1", "mb1", 365);
	f.insertMessage("was-filed", { folderId: "fld_news", status: "trash", created: 90, trashed: 30 });
	f.db.prepare("DELETE FROM folders WHERE id = 'fld_news'").run();
	assert.equal(f.db.prepare("SELECT folder_id FROM messages WHERE id = 'was-filed'").get().folder_id, null);
	assert.equal(await runTrashRetention(f.env, NOW), 1);
});

test("the two passes share one batch budget and drain oldest first", async (t) => {
	const f = await fixture(t);
	f.setGlobalDays("u1", 7);
	f.addFolder("fld_news", "u1", "mb1", 7);
	for (let index = 0; index < TRASH_RETENTION_BATCH_SIZE + 5; index += 1) {
		// index 0 is the oldest, so the first run must keep the five newest.
		f.insertMessage(`trash-${String(index).padStart(3, "0")}`, { status: "trash", created: 400, trashed: 300 - index });
	}
	for (let index = 0; index < 5; index += 1) f.insertMessage(`news-${index}`, { folderId: "fld_news", created: 40 });

	assert.equal(await runTrashRetention(f.env, NOW), TRASH_RETENTION_BATCH_SIZE, "one run never exceeds the batch size");
	assert.deepEqual(
		f.ids().filter((id) => id.startsWith("trash-")),
		["trash-200", "trash-201", "trash-202", "trash-203", "trash-204"],
		"the oldest Trash mail drains first",
	);
	assert.equal(f.ids().filter((id) => id.startsWith("news-")).length, 5, "the folder pass gets what the Trash pass leaves");

	assert.equal(await runTrashRetention(f.env, NOW), 10, "the second run finishes both passes");
	assert.deepEqual(f.ids(), []);
});

test("folder retention days outside 1-365 mean no folder rule", async (t) => {
	const f = await fixture(t);
	for (const [id, days] of [["fld_zero", 0], ["fld_negative", -5], ["fld_huge", 400]]) {
		f.addFolder(id, "u1", "mb1", days);
		f.insertMessage(`${id}-msg`, { folderId: id, created: 300 });
	}
	assert.equal(await runTrashRetention(f.env, NOW), 0);
	assert.equal(f.count(), 3);
});

test("every dialect's migration adds folders.retention_days", async () => {
	const { readFileSync } = await import("node:fs");
	const files = ["drizzle/migrations/0110_folder_retention_days.sql", "drizzle/migrations-pg/0034_folder_retention_days.sql", "drizzle/migrations-mysql/0034_folder_retention_days.sql"];
	for (const file of files) {
		const sql = readFileSync(join(root, file), "utf8");
		assert.match(sql, /ALTER TABLE [`"]folders[`"] ADD (COLUMN )?[`"]retention_days[`"] (integer|bigint);/, file);
	}
});
