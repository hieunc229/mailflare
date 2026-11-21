import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("jmap-folder-scope", `
	export { mailboxSet } from "./src/lib/jmap/mailboxes.ts";
	export { emailSet } from "./src/lib/jmap/emails.ts";
`);

const seed = `${sharedMailboxSeed("full_access")}
	INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('acc-3', 'mb-admin', 'delegate', 'read_only', 1);
	INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('f-own', 'delegate', 'mb-delegate', 'Mine', 1), ('f-foreign', 'admin', 'mb-admin', 'Theirs', 1);
	INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, folder_id, created_at) VALUES
		('m-foreign', 'admin', 'mb-admin', 'inbound', 'x@example.net', 'admin@example.com', 'Secret', 'received', 'f-foreign', 2),
		('m-own', 'delegate', 'mb-delegate', 'inbound', 'x@example.net', 'delegate@example.com', 'Mine', 'received', NULL, 2);
`;

function context(db, env) {
	return {
		env, db, accountId: "acct", origin: "http://localhost", createdIds: {}, memo: undefined,
		auth: { userId: "delegate", user: { id: "delegate", email: "delegate@example.com", role: "user" }, scopes: ["jmap"], mailboxIds: null },
	};
}

test("destroying a folder id from another mailbox cannot trash that mailbox's mail", async (t) => {
	const { env, db, sqlite } = await newDatabase(t, seed);
	const result = await app.mailboxSet(context(db, env), { destroy: ["mb-delegate~f~f-foreign"], onDestroyRemoveEmails: true });
	const row = sqlite.prepare("SELECT status, folder_id FROM messages WHERE id = 'm-foreign'").get();
	assert.deepEqual({ ...row }, { status: "received", folder_id: "f-foreign" });
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM folders WHERE id = 'f-foreign'").get().n, 1);
	assert.deepEqual(result.destroyed, []);
	assert.deepEqual(result.notDestroyed["mb-delegate~f~f-foreign"], { type: "notFound" });
});

test("destroying an own folder still moves its mail to trash", async (t) => {
	const { env, db, sqlite } = await newDatabase(t, seed);
	sqlite.exec("UPDATE messages SET folder_id = 'f-own' WHERE id = 'm-own'");
	const result = await app.mailboxSet(context(db, env), { destroy: ["mb-delegate~f~f-own"], onDestroyRemoveEmails: true });
	assert.deepEqual(result.destroyed, ["mb-delegate~f~f-own"]);
	assert.equal(sqlite.prepare("SELECT status FROM messages WHERE id = 'm-own'").get().status, "trash");
});

test("moving an email into a folder of another mailbox is refused", async (t) => {
	const { env, db, sqlite } = await newDatabase(t, seed);
	const result = await app.emailSet(context(db, env), { update: { "m-own": { mailboxIds: { "mb-delegate~f~f-foreign": true } } } });
	assert.ok(result.notUpdated["m-own"], "refused");
	assert.equal(sqlite.prepare("SELECT folder_id FROM messages WHERE id = 'm-own'").get().folder_id, null);
	const unknown = await app.emailSet(context(db, env), { update: { "m-own": { mailboxIds: { "mb-delegate~f~nope": true } } } });
	assert.ok(unknown.notUpdated["m-own"], "unknown folder refused");
	const own = await app.emailSet(context(db, env), { update: { "m-own": { mailboxIds: { "mb-delegate~f~f-own": true } } } });
	assert.deepEqual(own.updated, { "m-own": null });
	assert.equal(sqlite.prepare("SELECT folder_id FROM messages WHERE id = 'm-own'").get().folder_id, "f-own");
});

test("a read-only sharee cannot rename a folder of the shared mailbox", async (t) => {
	const teamSeed = `${sharedMailboxSeed("read_only")}
		INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('f-team', 'admin', 'mb-team', 'Team', 1);
	`;
	const { env, db, sqlite } = await newDatabase(t, teamSeed);
	const result = await app.mailboxSet(context(db, env), { update: { "mb-team~f~f-team": { name: "renamed" } } });
	assert.deepEqual(result.updated, {});
	assert.deepEqual(result.notUpdated["mb-team~f~f-team"], { type: "forbidden" });
	assert.equal(sqlite.prepare("SELECT name FROM folders WHERE id = 'f-team'").get().name, "Team");
});

test("a full-access owner can still rename their own folder", async (t) => {
	const { env, db, sqlite } = await newDatabase(t, seed);
	const result = await app.mailboxSet(context(db, env), { update: { "mb-delegate~f~f-own": { name: "Renamed" } } });
	assert.ok("mb-delegate~f~f-own" in result.updated);
	assert.equal(sqlite.prepare("SELECT name FROM folders WHERE id = 'f-own'").get().name, "Renamed");
});
