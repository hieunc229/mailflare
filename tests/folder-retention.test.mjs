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

/** A migrated SQLite database: owner u1 with mailboxes mb1 (shared) and mb1b, and a second account u2 with mb2. */
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
	db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mb1', 'u1', 'd1', 'one', 'shared', ?)").run(created);
	db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mb1b', 'u1', 'd1', 'alt', 'personal', ?)").run(created);
	db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mb2', 'u2', 'd2', 'two', 'personal', ?)").run(created);

	const addFolder = (id, userId, mailboxId, retentionDays) => {
		db.prepare("INSERT INTO folders (id, user_id, mailbox_id, name, color, retention_days, created_at) VALUES (?, ?, ?, ?, '#2563eb', ?, ?)").run(id, userId, mailboxId, id, retentionDays, created);
	};
	const files = [];
	const deletedKeys = [];
	const env = {
		DB: database,
		BUCKET: {
			delete: async (keys) => {
				const list = Array.isArray(keys) ? keys : [keys];
				deletedKeys.push(...list);
				await env.onDelete?.(list);
				for (const key of list) files.splice(files.indexOf(key) >>> 0, 1);
			},
		},
	};
	const put = (key) => files.push(key);

	const insertMessage = (id, { userId = "u1", mailboxId = "mb1", folderId = null, status = "received", direction = "inbound", created = 10, trashed = null, privateDraft = false, rawR2Key = null } = {}) => {
		db.prepare("INSERT INTO messages (id, user_id, mailbox_id, folder_id, direction, from_addr, to_addr, status, private_draft, created_at, raw_r2_key) VALUES (?, ?, ?, ?, ?, 'news@letter.example', 'one@example.com', ?, ?, ?, ?)")
			.run(id, userId, mailboxId, folderId, direction, status, privateDraft ? 1 : 0, daysAgo(created), rawR2Key);
		// The insert trigger stamps trashed_at for trash/spam, so an explicit value is written afterwards.
		if (trashed !== null) db.prepare("UPDATE messages SET trashed_at = ? WHERE id = ?").run(daysAgo(trashed), id);
		if (rawR2Key) put(rawR2Key);
	};
	const addOutboundJob = (id, messageId, status) => {
		db.prepare("INSERT INTO outbound_jobs (id, user_id, message_id, status, payload, created_at, updated_at) VALUES (?, 'u1', ?, ?, '{}', ?, ?)").run(id, messageId, status, created, created);
	};
	const setGlobalDays = (userId, days) => db.prepare("UPDATE users SET trash_retention_days = ? WHERE id = ?").run(days, userId);
	const ids = () => db.prepare("SELECT id FROM messages ORDER BY id").all().map((row) => row.id);
	const count = () => db.prepare("SELECT count(*) AS n FROM messages").get().n;
	const auditRows = () => db.prepare("SELECT actor_user_id, mailbox_id, metadata FROM audit_logs WHERE action = 'email.delete'").all();

	return { env, db, insertMessage, addFolder, addOutboundJob, setGlobalDays, ids, count, auditRows, files, deletedKeys };
}

test("a folder rule purges aged filed mail that is not in Trash, and only past its own window", async (t) => {
	const f = await fixture(t);
	f.addFolder("fld_news", "u1", "mb1", 7);
	f.insertMessage("old", { folderId: "fld_news", status: "received", created: 10, rawR2Key: "raw/old" });
	f.insertMessage("young", { folderId: "fld_news", status: "received", created: 3 });
	f.insertMessage("archived", { folderId: "fld_news", status: "archived", created: 30 });

	assert.equal(await runTrashRetention(f.env, NOW), 2);
	assert.deepEqual(f.ids(), ["young"]);
	assert.deepEqual(f.deletedKeys, ["raw/old"], "the raw MIME object goes with the row");
	const audits = f.auditRows();
	assert.equal(audits.length, 2);
	assert.ok(audits.every((row) => JSON.parse(row.metadata).source === "retention"));
});

test("the folder rule only deletes an explicit status set: sent, unknown and pipeline statuses survive", async (t) => {
	const f = await fixture(t);
	f.addFolder("fld_news", "u1", "mb1", 7);
	// `messages.status` is free text, so an unrecognised value must mean "keep".
	for (const status of ["sent", "draft", "queued", "failed", "trash", "spam", "outbox", "sending", "future_unknown"]) {
		f.insertMessage(`st-${status}`, { folderId: "fld_news", status, created: 90, direction: status === "received" ? "inbound" : "outbound" });
	}
	f.insertMessage("eligible", { folderId: "fld_news", status: "received", created: 90 });

	assert.equal(await runTrashRetention(f.env, NOW), 1);
	assert.deepEqual(f.ids(), ["st-draft", "st-failed", "st-outbox", "st-queued", "st-sent", "st-sending", "st-spam", "st-trash", "st-future_unknown"].sort());
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

test("folder rules age filed mail by createdAt, while Trash retention keeps using trashedAt", async (t) => {
	const f = await fixture(t);
	f.setGlobalDays("u1", 90);
	f.addFolder("fld_news", "u1", "mb1", 30);
	// Both are 40 days old, but only 2 days into their Trash window. The folder rule may not touch Trash mail,
	// so neither is due: folder rules use the message date, Trash retention uses trashedAt.
	f.insertMessage("in-folder", { folderId: "fld_news", status: "trash", created: 40, trashed: 2 });
	f.insertMessage("plain-trash", { status: "trash", created: 40, trashed: 2 });
	assert.equal(await runTrashRetention(f.env, NOW), 0);
	assert.deepEqual(f.ids(), ["in-folder", "plain-trash"]);

	// Once the Trash window is up, the global rule removes both, filed or not.
	f.setGlobalDays("u1", 1);
	assert.equal(await runTrashRetention(f.env, NOW), 2);
	assert.deepEqual(f.ids(), []);
});

test("an unsent draft filed through archive-then-move keeps its private_draft flag and survives", async (t) => {
	const f = await fixture(t);
	f.addFolder("fld_news", "u1", "mb1", 7);
	// The bulk/archive flows rewrite the display status to `received`; the provenance flag is the guard.
	f.insertMessage("filed-draft", { folderId: "fld_news", status: "received", direction: "outbound", created: 90, privateDraft: true });
	assert.equal(await runTrashRetention(f.env, NOW), 0);
	assert.deepEqual(f.ids(), ["filed-draft"]);
});

test("a folder rule never deletes outbound mail, while a deliberately trashed sent copy still goes", async (t) => {
	const f = await fixture(t);
	f.setGlobalDays("u1", 7);
	f.addFolder("fld_news", "u1", "mb1", 7);
	// Status cannot carry provenance: a completed send filed here is `received` with direction `outbound`.
	f.insertMessage("filed-sent", { folderId: "fld_news", status: "received", direction: "outbound", created: 90 });
	f.insertMessage("filed-inbound", { folderId: "fld_news", status: "received", created: 90 });
	// The user threw this sent copy away themselves, so the Trash rule still owns it.
	f.insertMessage("trashed-sent", { status: "trash", direction: "outbound", created: 90, trashed: 60 });

	assert.equal(await runTrashRetention(f.env, NOW), 2, "the filed inbound message and the explicitly trashed sent copy");
	assert.deepEqual(f.ids(), ["filed-sent"]);
});

test("a message a live outbound job still owns is never purged, whatever its status", async (t) => {
	const f = await fixture(t);
	f.addFolder("fld_news", "u1", "mb1", 7);
	f.setGlobalDays("u1", 7);
	for (const [id, jobStatus] of [["job-queued", "queued"], ["job-sending", "sending"], ["job-sent", "sent"], ["job-failed", "failed"]]) {
		f.insertMessage(id, { folderId: "fld_news", status: "received", created: 90 });
		f.addOutboundJob(`out-${id}`, id, jobStatus);
	}
	f.insertMessage("in-trash-with-job", { status: "trash", created: 90, trashed: 60 });
	f.addOutboundJob("out-good", "in-trash-with-job", "sending");

	assert.equal(await runTrashRetention(f.env, NOW), 2, "only the terminal jobs' messages go");
	assert.deepEqual(f.ids(), ["in-trash-with-job", "job-queued", "job-sending"]);
	assert.deepEqual(
		f.db.prepare("SELECT id, message_id, status FROM outbound_jobs ORDER BY id").all().map((row) => [row.id, row.message_id, row.status]),
		[["out-good", "in-trash-with-job", "sending"], ["out-job-failed", null, "failed"], ["out-job-queued", "job-queued", "queued"], ["out-job-sending", "job-sending", "sending"], ["out-job-sent", null, "sent"]],
		"no live job was stranded: only terminal sent/failed jobs lost their message",
	);
});

test("a folder rule is bound to the folder's mailbox and mailbox owner, not to the message's claims", async (t) => {
	const f = await fixture(t);
	f.addFolder("fld_news", "u1", "mb1", 7);
	// Same folder id, but the message lives in another mailbox: never in scope.
	f.insertMessage("other-mailbox", { mailboxId: "mb1b", folderId: "fld_news", created: 90 });
	// A delegate's message filed in the shared mailbox's folder follows the mailbox owner's rule.
	f.insertMessage("delegated", { userId: "u2", mailboxId: "mb1", folderId: "fld_news", created: 90 });

	assert.equal(await runTrashRetention(f.env, NOW), 1);
	assert.deepEqual(f.ids(), ["other-mailbox"]);
	const [audit] = f.auditRows();
	assert.equal(audit.actor_user_id, "u1", "the mailbox owner is the authoritative actor");
	assert.equal(audit.mailbox_id, "mb1");
});

test("the mailbox owner wins over a folder row whose user_id disagrees", async (t) => {
	const f = await fixture(t);
	// A stale fixtures-only mismatch: the folder claims u1 but lives in u2's mailbox.
	f.addFolder("fld_cross", "u1", "mb2", 7);
	f.insertMessage("u2-mail", { userId: "u2", mailboxId: "mb2", folderId: "fld_cross", created: 90 });

	assert.equal(await runTrashRetention(f.env, NOW), 1);
	assert.deepEqual(f.ids(), []);
	assert.equal(f.auditRows()[0].actor_user_id, "u2");
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

test("a mid-batch storage failure cannot borrow budget from the next pass, and the count is the rows actually gone", async (t) => {
	const f = await fixture(t);
	f.setGlobalDays("u1", 7);
	f.addFolder("fld_news", "u1", "mb1", 7);
	for (let index = 0; index < TRASH_RETENTION_BATCH_SIZE; index += 1) {
		// index 0 is attempted first, so the last one is the one whose storage call fails.
		f.insertMessage(`trash-${String(index).padStart(3, "0")}`, {
			status: "trash",
			created: 400,
			trashed: 300 - index,
			rawR2Key: index === TRASH_RETENTION_BATCH_SIZE - 1 ? "fail-budget.eml" : null,
		});
	}
	for (let index = 0; index < 205; index += 1) f.insertMessage(`news-${String(index).padStart(3, "0")}`, { folderId: "fld_news", created: 40 });

	const before = f.count();
	f.env.onDelete = async (keys) => {
		if (keys.includes("fail-budget.eml")) throw new Error("injected storage failure");
	};

	const claimed = await runTrashRetention(f.env, NOW);
	const physicallyDeleted = before - f.count();
	assert.equal(claimed, physicallyDeleted, "the reported count matches what is actually gone");
	assert.equal(physicallyDeleted, TRASH_RETENTION_BATCH_SIZE, "the row delete is the claim: the 200th row is gone too");
	assert.ok(physicallyDeleted <= TRASH_RETENTION_BATCH_SIZE, "the cap holds even though an object delete failed");
	assert.equal(f.ids().filter((id) => id.startsWith("news-")).length, 205, "the folder pass got no leftover budget");
	assert.deepEqual(f.ids().filter((id) => id.startsWith("trash-")), [], "no row survives a claim");
	assert.deepEqual(f.files, ["fail-budget.eml"], "the documented trade-off: the row is gone, its object is orphaned");

	f.env.onDelete = undefined;
	// The next run has a full budget again and spends it on the folder backlog.
	assert.equal(await runTrashRetention(f.env, NOW), 200, "the next run starts from a full budget");
	assert.equal(f.ids().filter((id) => id.startsWith("news-")).length, 5);
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

test("an unreadable database is logged, not thrown: the run reports 0", async () => {
	const broken = { prepare() { throw new Error("discovery break"); } };
	const errors = [];
	const original = console.error;
	console.error = (...args) => errors.push(args.join(" "));
	try {
		assert.equal(await runTrashRetention({ DB: broken, BUCKET: { delete: async () => {} } }, NOW), 0);
	} finally {
		console.error = original;
	}
	assert.ok(errors.some((line) => line.includes("could not list owners")), "the failure is conspicuous in the logs");
});

test("every dialect's migration adds folders.retention_days", async () => {
	const { readFileSync } = await import("node:fs");
	const files = ["drizzle/migrations/0110_folder_retention_days.sql", "drizzle/migrations-pg/0034_folder_retention_days.sql", "drizzle/migrations-mysql/0034_folder_retention_days.sql"];
	for (const file of files) {
		const sql = readFileSync(join(root, file), "utf8");
		assert.match(sql, /ALTER TABLE [`"]folders[`"] ADD (COLUMN )?[`"]retention_days[`"] (integer|bigint);/, file);
	}
});
