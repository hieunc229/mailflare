import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("jmap-write-gate", `export { emailSet } from "./src/lib/jmap/emails.ts";`);

const messages = `
	INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, read, private_draft, created_at) VALUES
		('m-1', 'admin', 'mb-team', 'inbound', 'x@example.net', 'team@example.com', 'One', 'received', 0, 0, 2),
		('m-2', 'admin', 'mb-team', 'inbound', 'x@example.net', 'team@example.com', 'Two', 'received', 0, 0, 3),
		('d-own', 'delegate', 'mb-team', 'outbound', 'team@example.com', 'x@example.net', 'Mine', 'draft', 1, 1, 4),
		('d-other', 'author', 'mb-team', 'outbound', 'team@example.com', 'x@example.net', 'Theirs', 'draft', 1, 1, 5);
`;

const context = (db, env) => ({
	env, db, accountId: "acct", origin: "http://localhost", createdIds: {}, memo: undefined,
	auth: { userId: "delegate", user: { id: "delegate", email: "delegate@example.com", role: "user" }, scopes: ["jmap"], mailboxIds: null },
});

test("a send_on_behalf delegate can mark mail read but cannot move or delete it", async (t) => {
	const { env, db, sqlite } = await newDatabase(t, sharedMailboxSeed("send_on_behalf") + messages);
	const flags = await app.emailSet(context(db, env), { update: { "m-1": { "keywords/$seen": true } } });
	assert.deepEqual(flags.updated, { "m-1": null });
	assert.equal(sqlite.prepare("SELECT read FROM messages WHERE id = 'm-1'").get().read, 1);

	const move = await app.emailSet(context(db, env), { update: { "m-2": { mailboxIds: { "mb-team~trash": true } } } });
	assert.equal(move.notUpdated["m-2"].type, "forbidden");
	assert.equal(sqlite.prepare("SELECT status FROM messages WHERE id = 'm-2'").get().status, "received");

	const destroy = await app.emailSet(context(db, env), { destroy: ["m-2"] });
	assert.equal(destroy.notDestroyed["m-2"].type, "forbidden");
	assert.equal(sqlite.prepare("SELECT status FROM messages WHERE id = 'm-2'").get().status, "received");
});

test("a delegate can still delete their own draft, but not someone else's", async (t) => {
	const { env, db, sqlite } = await newDatabase(t, sharedMailboxSeed("send_on_behalf") + messages);
	const result = await app.emailSet(context(db, env), { destroy: ["d-own", "d-other"] });
	assert.deepEqual(result.destroyed, ["d-own"]);
	assert.ok(result.notDestroyed["d-other"]);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM messages WHERE id = 'd-own'").get().n, 0);
});

test("full_access keeps moving and deleting", async (t) => {
	const { env, db, sqlite } = await newDatabase(t, sharedMailboxSeed("full_access") + messages);
	const move = await app.emailSet(context(db, env), { update: { "m-2": { mailboxIds: { "mb-team~trash": true } } } });
	assert.deepEqual(move.updated, { "m-2": null });
	assert.equal(sqlite.prepare("SELECT status FROM messages WHERE id = 'm-2'").get().status, "trash");
	const destroy = await app.emailSet(context(db, env), { destroy: ["m-1"] });
	assert.deepEqual(destroy.destroyed, ["m-1"]);
});
