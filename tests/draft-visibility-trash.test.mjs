import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

// A draft stays private to its author wherever the author puts it (Trash, Archive, a folder, the
// inbox), because messages.private_draft is set when the row is created as a draft. Sent mail that
// a teammate files or trashes is not a draft and stays visible to the mailbox's readers.
const mocks = {
	"@/lib/cloudflare": "export function getEnv(){return globalThis.trashEnv}",
	"@/lib/auth/cookies": "export async function getCurrentUser(){return globalThis.trashUser} export async function requireUser(){return globalThis.trashUser}",
};
const { app, newDatabase } = await loadApp("draft-trash", `
	export { getMessageWithBodyForUser } from "./src/lib/email/inbound.ts";
	export { emailGet, emailQuery } from "./src/lib/jmap/emails.ts";
	export { currentChangeScope, emailChangesSince } from "./src/lib/jmap/changes.ts";
	export { buildAllMailboxes } from "./src/lib/jmap/mailboxes.ts";
	export { isOthersDraft } from "./src/lib/email/draft-access.ts";
	export * as bulk from "./src/app/api/messages/bulk/route.ts";
	export * as list from "./src/app/api/messages/route.ts";
	export * as counts from "./src/app/api/messages/counts/route.ts";
`, { mocks });

const seed = `${sharedMailboxSeed("full_access")}
	INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('f-1', 'admin', 'mb-team', 'Clients', 1);
	INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, private_draft, created_at) VALUES
		('m-1', 'admin', 'mb-team', 'inbound', 'x@example.net', 'team@example.com', 'Hello', 'visible', 'received', 0, 2),
		('t-inbound', 'admin', 'mb-team', 'inbound', 'x@example.net', 'team@example.com', 'Old', 'visible', 'trash', 0, 3),
		('draft-1', 'author', 'mb-team', 'outbound', 'team@example.com', 'x@example.net', 'Unsent', 'private text', 'draft', 1, 4),
		('sent-1', 'author', 'mb-team', 'outbound', 'team@example.com', 'x@example.net', 'Sent one', 'shared text', 'sent', 0, 5);
`;
const user = (id) => ({ id, email: `${id}@example.com`, role: "user" });
const jmap = (db, env, id) => ({ env, db, accountId: "acct", origin: "http://localhost", createdIds: {}, memo: undefined, auth: { userId: id, user: user(id), scopes: ["jmap"], mailboxIds: null } });
const get = (url) => new Request(`http://localhost${url}`);
const post = (body) => new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function setup(t, who, sql = "") {
	const fixture = await newDatabase(t, seed);
	if (sql) fixture.sqlite.exec(sql);
	fixture.env.BUCKET = { get: async () => ({ body: "x" }), delete: async () => {} };
	globalThis.trashEnv = fixture.env;
	globalThis.trashUser = user(who);
	return fixture;
}
const moves = {
	trash: "UPDATE messages SET status = 'trash' WHERE id = 'draft-1'",
	archived: "UPDATE messages SET status = 'archived' WHERE id = 'draft-1'",
	inbox: "UPDATE messages SET status = 'received' WHERE id = 'draft-1'",
	folder: "UPDATE messages SET status = 'received', folder_id = 'f-1' WHERE id = 'draft-1'",
};

test("the row helper follows private_draft and the author, and fails closed on a missing column", () => {
	const row = (privateDraft, userId = "author") => ({ privateDraft, userId });
	assert.equal(app.isOthersDraft(row(true), "delegate"), true);
	assert.equal(app.isOthersDraft(row(true), "author"), false);
	assert.equal(app.isOthersDraft(row(false), "delegate"), false);
	assert.equal(app.isOthersDraft({ userId: "author" }, "delegate"), true);
});

for (const [name, sql] of Object.entries(moves)) {
	test(`a draft its author moved to ${name} stays hidden from a delegate over REST and JMAP`, async (t) => {
		const { env, db } = await setup(t, "delegate", sql);
		assert.equal(await app.getMessageWithBodyForUser(env, user("delegate"), "draft-1"), null);
		assert.ok(await app.getMessageWithBodyForUser(env, user("author"), "draft-1"));
		assert.ok(!(await app.emailQuery(jmap(db, env, "delegate"), {})).ids.includes("draft-1"));
		assert.deepEqual((await app.emailGet(jmap(db, env, "delegate"), { ids: ["draft-1"] })).notFound, ["draft-1"]);
		assert.ok((await app.emailQuery(jmap(db, env, "author"), {})).ids.includes("draft-1"));
		const since = `c1:0:${(await app.currentChangeScope(jmap(db, env, "delegate"))).fingerprint}`;
		const changes = await app.emailChangesSince(jmap(db, env, "delegate"), { sinceState: since });
		assert.ok(![...changes.created, ...changes.updated, ...changes.destroyed].includes("draft-1"));
	});
}

test("sent mail a teammate trashed, restored or filed in a shared folder stays visible to others", async (t) => {
	for (const sql of [
		"UPDATE messages SET status = 'trash' WHERE id = 'sent-1'",
		"UPDATE messages SET status = 'trash' WHERE id = 'sent-1'; UPDATE messages SET status = 'received' WHERE id = 'sent-1'",
		"UPDATE messages SET status = 'archived' WHERE id = 'sent-1'",
		"UPDATE messages SET folder_id = 'f-1' WHERE id = 'sent-1'",
	]) {
		const { env, db } = await setup(t, "delegate", sql);
		assert.ok(await app.getMessageWithBodyForUser(env, user("delegate"), "sent-1"), sql);
		assert.ok((await app.emailQuery(jmap(db, env, "delegate"), {})).ids.includes("sent-1"), sql);
		assert.equal((await app.emailGet(jmap(db, env, "delegate"), { ids: ["sent-1"] })).list.length, 1, sql);
	}
});

test("the Trash list and counts leave out another user's trashed draft only", async (t) => {
	await setup(t, "delegate", `${moves.trash}; UPDATE messages SET status = 'trash' WHERE id = 'sent-1'`);
	const body = await (await app.list.GET(get("/api/messages?status=trash&mailboxId=mb-team"))).json();
	assert.deepEqual((body.messages ?? body.items ?? []).map((m) => m.id).sort(), ["sent-1", "t-inbound"]);
	const counts = await (await app.counts.GET(get("/api/messages/counts"))).json();
	assert.equal(counts.counts.folders.trash.total, 2);
	globalThis.trashUser = user("author");
	assert.equal((await (await app.counts.GET(get("/api/messages/counts"))).json()).counts.folders.trash.total, 3);
});

test("empty-trash and restore skip another user's trashed draft", async (t) => {
	const { sqlite } = await setup(t, "delegate", moves.trash);
	await app.bulk.POST(post({ messageIds: ["draft-1", "t-inbound"], action: "delete" }));
	assert.ok(sqlite.prepare("SELECT 1 FROM messages WHERE id = 'draft-1'").get());
	assert.equal(sqlite.prepare("SELECT 1 FROM messages WHERE id = 't-inbound'").get(), undefined);
	assert.equal((await app.bulk.POST(post({ messageIds: ["draft-1"], action: "inbox" }))).status, 404);
	assert.equal(sqlite.prepare("SELECT status FROM messages WHERE id = 'draft-1'").get().status, "trash");
});

test("JMAP mailbox totals leave out another user's draft wherever it is filed", async (t) => {
	const { env, db } = await setup(t, "delegate", moves.trash);
	const total = async (id, name) => (await app.buildAllMailboxes(jmap(db, env, id))).find((m) => m.name === name && String(m.id).includes("mb-team"))?.totalEmails;
	assert.equal(await total("delegate", "Trash"), 1);
	assert.equal(await total("author", "Trash"), 2);
	assert.equal(await total("delegate", "Drafts"), 0);
});
