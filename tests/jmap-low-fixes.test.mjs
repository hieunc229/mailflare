import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("jmap-low-fixes", `
	export { emailQuery, searchSnippetGet } from "./src/lib/jmap/emails.ts";
	export { mailboxIdsFor } from "./src/lib/jmap/email-objects.ts";
	export { currentChangeScope, threadChangesSince } from "./src/lib/jmap/changes.ts";
`);

const jmap = (db, env, id, memo = undefined) => ({
	env, db, accountId: "acct", origin: "http://localhost", createdIds: {}, memo,
	auth: { userId: id, user: { id, email: `${id}@example.com`, role: "user" }, scopes: ["jmap"], mailboxIds: null },
});
const insert = (cols) => `INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at${cols ? `, ${cols.names}` : ""}) VALUES `;
const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);

async function setup(t, extra = "") {
	return newDatabase(t, `${sharedMailboxSeed("full_access")}${extra}`);
}

// Snoozing ends by the clock, which writes nothing and so never reaches Email/changes: a client that cached "no mailbox" would never see the message return.
test("snoozed mail keeps its Inbox membership in JMAP", async (t) => {
	const { env, db } = await setup(t, `
		${insert({ names: "snoozed_until" })} ('m-future', 'admin', 'mb-team', 'inbound', 'a@x.test', 'team@example.com', 'S', 'b', 'received', 11, ${now() + DAY});`);
	const { ids } = await app.emailQuery(jmap(db, env, "delegate"), { filter: { inMailbox: "mb-team~inbox" } });
	assert.deepEqual(ids, ["m-future"]);
	assert.deepEqual(app.mailboxIdsFor({ mailboxId: "mb-team", folderId: null, status: "received", snoozedUntil: new Date(Date.now() + DAY * 1000) }), { "mb-team~inbox": true });
});

test("snippet highlighting never splits an HTML entity", async (t) => {
	const { env, db } = await setup(t, `${insert()} ('s1', 'admin', 'mb-team', 'inbound', 'a@x.test', 'team@example.com', 'A & B', 'x & y amp z', 'received', 10);
		${insert()} ('s2', 'admin', 'mb-team', 'inbound', 'a@x.test', 'team@example.com', '1 < 2', 'x', 'received', 11);`);
	const get = async (id, text) => (await app.searchSnippetGet(jmap(db, env, "delegate"), { emailIds: [id], filter: { text } })).list[0];
	const amp = await get("s1", "amp");
	assert.equal(amp.subject, "A &amp; B");
	assert.match(amp.preview, /<mark>amp<\/mark> z/);
	assert.doesNotMatch(amp.preview, /&<mark>/);
	assert.equal((await get("s1", "&")).subject, "A <mark>&amp;</mark> B");
	assert.equal((await get("s1", "a")).subject, "<mark>A</mark> &amp; B");
	assert.equal((await get("s2", "<")).subject, "1 <mark>&lt;</mark> 2");
});

test("Thread/changes keeps a thread with a later update in updated", async (t) => {
	const { env, db, sqlite } = await setup(t);
	const ctx = () => jmap(db, env, "delegate", null);
	const state = (await app.currentChangeScope(ctx())).state;
	sqlite.exec(`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, thread_id, created_at) VALUES
			('n1', 'admin', 'mb-team', 'inbound', 'a@x.test', 'team@example.com', 'S', 'b', 'received', 't-new', 10),
			('x1', 'admin', 'mb-team', 'inbound', 'a@x.test', 'team@example.com', 'S', 'b', 'received', 't-mixed', 11);
		UPDATE messages SET read = 1 WHERE id = 'x1';`);
	const result = await app.threadChangesSince(ctx(), { sinceState: state });
	assert.deepEqual(result.created, ["t-new"], JSON.stringify(result));
	assert.deepEqual(result.updated, ["t-mixed"], JSON.stringify(result));
	assert.deepEqual(result.destroyed, []);
});

test("the access fingerprint ignores promotion settings of mailboxes the caller cannot see", async (t) => {
	const { env, db, sqlite } = await setup(t);
	sqlite.exec("INSERT INTO mailbox_promotion_settings (mailbox_id, mode, updated_at) VALUES ('mb-team', 'show', 1), ('mb-admin', 'separate', 1), ('mb-delegate', 'off', 1)");
	const fingerprint = async () => (await app.currentChangeScope(jmap(db, env, "delegate", null))).fingerprint;
	const before = await fingerprint();
	sqlite.exec("UPDATE mailbox_promotion_settings SET mode = 'off' WHERE mailbox_id = 'mb-admin'");
	assert.equal(await fingerprint(), before);
	sqlite.exec("UPDATE mailbox_promotion_settings SET mode = 'off' WHERE mailbox_id = 'mb-team'");
	assert.notEqual(await fingerprint(), before);
});
