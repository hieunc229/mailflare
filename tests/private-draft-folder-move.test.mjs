import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

// A private draft the author moves between folders over JMAP must stay private: a folder move
// is not a send. Only an explicit "sent" (a real send, or the author marking it sent) releases it.
const { app, newDatabase } = await loadApp("private-draft-folder-move", `
	export { emailSet, emailGet } from "./src/lib/jmap/emails.ts";
	export { encodeMailboxRef } from "./src/lib/jmap/ids.ts";
`);
const seed = `${sharedMailboxSeed("read_only")}
	UPDATE mailbox_access SET permission = 'full_access' WHERE user_id = 'author';
	INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('f1','admin','mb-team','F1',1),('f2','admin','mb-team','F2',1);
	INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, private_draft, created_at) VALUES
		('d-trash','author','mb-team','outbound','team@example.com','x@y.z','secret one','unsent','trash',1,2),
		('d-live','author','mb-team','outbound','team@example.com','x@y.z','secret two','unsent','draft',1,3),
		('s-sent','author','mb-team','outbound','team@example.com','x@y.z','shared','sent','sent',0,4);`;
const ctx = (db, env, id) => ({ env, db, accountId: "acct", origin: "http://localhost", createdIds: {}, memo: undefined,
	auth: { userId: id, user: { id, email: `${id}@example.com`, role: "user" }, scopes: ["jmap"], mailboxIds: null } });
const priv = (sqlite, id) => sqlite.prepare("SELECT private_draft AS p FROM messages WHERE id = ?").get(id).p;

test("moving a private draft between folders keeps it hidden from other readers", async (t) => {
	const { env, db, sqlite } = await newDatabase(t, seed);
	const ref = (folderId) => app.encodeMailboxRef({ kind: "folder", mailboxId: "mb-team", folderId });
	const move = (id, folderId) => app.emailSet(ctx(db, env, "author"), { update: { [id]: { mailboxIds: { [ref(folderId)]: true } } } });
	for (const folder of ["f1", "f2"]) {
		for (const id of ["d-trash", "d-live"]) assert.deepEqual((await move(id, folder)).notUpdated, {});
	}
	assert.equal(priv(sqlite, "d-trash"), 1);
	assert.equal(priv(sqlite, "d-live"), 1);
	const seen = await app.emailGet(ctx(db, env, "delegate"), { ids: ["d-trash", "d-live"], properties: ["subject"] });
	assert.deepEqual(seen.list, []);
	assert.deepEqual(seen.notFound.sort(), ["d-live", "d-trash"]);
});

test("filing sent mail in a folder keeps it visible, and marking a draft sent releases it", async (t) => {
	const { env, db, sqlite } = await newDatabase(t, seed);
	const f1 = app.encodeMailboxRef({ kind: "folder", mailboxId: "mb-team", folderId: "f1" });
	await app.emailSet(ctx(db, env, "author"), { update: { "s-sent": { mailboxIds: { [f1]: true } } } });
	assert.equal(priv(sqlite, "s-sent"), 0);
	assert.equal(sqlite.prepare("SELECT status FROM messages WHERE id = 's-sent'").get().status, "sent");
	const sentBox = app.encodeMailboxRef({ kind: "role", mailboxId: "mb-team", role: "sent" });
	await app.emailSet(ctx(db, env, "author"), { update: { "d-live": { mailboxIds: { [sentBox]: true } } } });
	assert.equal(priv(sqlite, "d-live"), 0);
});
