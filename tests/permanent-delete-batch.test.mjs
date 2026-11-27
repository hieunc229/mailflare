import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("permanent-delete-batch", `
	export { deleteMessagesWithObjects, deleteMessageWithObjects } from "./src/lib/email/message-cleanup.ts";
	export { permanentlyDeleteMessages } from "./src/lib/email/permanent-delete.ts";
`);

const seed = `
	INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u', 'u@example.com', 'U', 'x', 1);
	INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d', 'u', 'example.com', 'zone', 1);
	INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mb', 'u', 'd', 'me', 'personal', 1);
`;

function message(sqlite, id, rawKey, attachments = []) {
	sqlite.prepare("INSERT INTO messages (id, mailbox_id, user_id, direction, from_addr, to_addr, subject, status, raw_r2_key, created_at) VALUES (?, 'mb', 'u', 'inbound', 'a@b.test', 'me@example.com', 's', 'trash', ?, 1)").run(id, rawKey);
	for (const [index, key] of attachments.entries()) {
		sqlite.prepare("INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, created_at) VALUES (?, ?, 'a.pdf', 'application/pdf', 3, ?, 1)").run(`${id}-att${index}`, id, key);
	}
}

function bucket() {
	const fake = { deleted: [], calls: 0, delete: async (keys) => { fake.calls += 1; fake.deleted.push(...[].concat(keys)); } };
	return fake;
}

const count = (sqlite, table) => sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test("batch cleanup deletes raw and unshared attachment objects but keeps shared ones", async (t) => {
	const { env, sqlite, db } = await newDatabase(t, seed);
	const BUCKET = bucket();
	env.BUCKET = BUCKET;
	message(sqlite, "m1", "raw/m1", ["att/own"]);
	message(sqlite, "m2", "raw/m2", ["att/shared"]);
	message(sqlite, "m3", null);
	sqlite.prepare("INSERT INTO drive_items (id, owner_id, kind, name, r2_key, size, created_at, updated_at) VALUES ('item', 'u', 'file', 'a.pdf', 'att/shared', 3, 1, 1)").run();
	await app.deleteMessagesWithObjects(env, db, [{ id: "m1", rawR2Key: "raw/m1" }, { id: "m2", rawR2Key: "raw/m2" }, { id: "m3", rawR2Key: null }]);
	assert.deepEqual(BUCKET.deleted.sort(), ["att/own", "raw/m1", "raw/m2"]);
	assert.equal(count(sqlite, "messages"), 0);
});

test("single-message helper behaves like a batch of one", async (t) => {
	const { env, sqlite, db } = await newDatabase(t, seed);
	const BUCKET = bucket();
	env.BUCKET = BUCKET;
	message(sqlite, "m4", "raw/m4", ["att/m4"]);
	await app.deleteMessageWithObjects(env, db, "m4", "raw/m4");
	assert.deepEqual(BUCKET.deleted.sort(), ["att/m4", "raw/m4"]);
	assert.equal(count(sqlite, "messages"), 0);
});

test("permanent delete writes one audit row per message with the old metadata", async (t) => {
	const { env, sqlite, db } = await newDatabase(t, seed);
	env.BUCKET = bucket();
	const rows = ["x1", "x2", "x3"].map((id) => ({ id, mailboxId: "mb", rawR2Key: `raw/${id}`, status: "trash" }));
	for (const row of rows) message(sqlite, row.id, row.rawR2Key);
	assert.equal(await app.permanentlyDeleteMessages(env, db, "u", rows, "bulk"), 3);
	const audit = sqlite.prepare("SELECT action, metadata, mailbox_id FROM audit_logs").all();
	assert.equal(audit.length, 3);
	for (const row of audit) assert.equal(row.action, "email.delete");
	assert.deepEqual(audit.map((row) => JSON.parse(row.metadata)).sort((a, b) => a.messageId.localeCompare(b.messageId)),
		rows.map((row) => ({ permanent: true, source: "bulk", messageId: row.id, previousStatus: "trash" })));
	assert.ok(audit.every((row) => row.mailbox_id === "mb"));
});
