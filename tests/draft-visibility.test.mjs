import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("draft-visibility", `
	export { getMessageWithBodyForUser, getMessageMetadataForUser } from "./src/lib/email/inbound.ts";
	export { getAttachmentForUser } from "./src/lib/email/attachments.ts";
	export { getMessageThreadForUser } from "./src/lib/email/thread-view.ts";
	export { emailGet, emailQuery } from "./src/lib/jmap/emails.ts";
	export { readBlob } from "./src/lib/jmap/blobs.ts";
	export { currentChangeScope, emailChangesSince, mailboxChangesSince, threadChangesSince } from "./src/lib/jmap/changes.ts";
	export { buildAllMailboxes } from "./src/lib/jmap/mailboxes.ts";
	export { cancelScheduledSend } from "./src/lib/email/scheduled.ts";
	export { attachmentBlobId, messageBlobId } from "./src/lib/jmap/ids.ts";
`);

// 'author' (send_on_behalf) wrote the draft in the shared mailbox; 'delegate' can only read it.
const seed = `${sharedMailboxSeed("read_only")}
	INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, private_draft, created_at) VALUES
		('m-1', 'admin', 'mb-team', 'inbound', 'x@example.net', 'team@example.com', 'Hello', 'visible', 'received', 0, 2),
		('draft-1', 'author', 'mb-team', 'outbound', 'team@example.com', 'x@example.net', 'Unsent', 'private text', 'draft', 1, 3);
	INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, disposition, created_at) VALUES ('att-1', 'draft-1', 'plan.txt', 'text/plain', 3, 'k1', 'attachment', 1);
`;
const user = (id) => ({ id, email: `${id}@example.com`, role: "user" });
const jmap = (db, env, id) => ({
	env, db, accountId: "acct", origin: "http://localhost", createdIds: {}, memo: undefined,
	auth: { userId: id, user: user(id), scopes: ["jmap"], mailboxIds: null },
});

test("a reader of the shared mailbox cannot open another user's draft", async (t) => {
	const { env } = await newDatabase(t, seed);
	env.BUCKET = { get: async () => ({ body: "x" }) };
	assert.equal(await app.getMessageWithBodyForUser(env, user("delegate"), "draft-1"), null);
	assert.equal(await app.getMessageMetadataForUser(env, user("delegate"), "draft-1"), null);
	assert.equal(await app.getMessageThreadForUser(env, user("delegate"), "draft-1"), null);
	assert.equal(await app.getAttachmentForUser(env, user("delegate"), "draft-1", "att-1"), null);
	assert.ok(await app.getMessageWithBodyForUser(env, user("delegate"), "m-1"), "ordinary mail is still readable");
});

test("the draft's author still sees it", async (t) => {
	const { env } = await newDatabase(t, seed);
	env.BUCKET = { get: async () => ({ body: "x" }) };
	assert.ok(await app.getMessageWithBodyForUser(env, user("author"), "draft-1"));
	assert.ok(await app.getAttachmentForUser(env, user("author"), "draft-1", "att-1"));
});

test("JMAP hides another user's draft from queries and gets", async (t) => {
	const { env, db } = await newDatabase(t, seed);
	const query = await app.emailQuery(jmap(db, env, "delegate"), {});
	assert.deepEqual(query.ids.sort(), ["m-1"]);
	const get = await app.emailGet(jmap(db, env, "delegate"), { ids: ["draft-1", "m-1"] });
	assert.deepEqual(get.list.map((row) => row.id), ["m-1"]);
	assert.deepEqual(get.notFound, ["draft-1"]);
	const own = await app.emailQuery(jmap(db, env, "author"), {});
	assert.deepEqual(own.ids.sort(), ["draft-1", "m-1"]);
});

test("the REST list applies the draft predicate", () => {
	const source = readFileSync(new URL("../src/app/api/messages/route.ts", import.meta.url), "utf8");
	assert.match(source, /conditions\.push\(draftsVisibleTo\(user\.id\)\)/);
});

test("JMAP blobs of another user's draft are not served", async (t) => {
	const { env, db } = await newDatabase(t, seed);
	env.BUCKET = { get: async () => ({ body: "x", size: 1 }) };
	assert.equal(await app.readBlob(jmap(db, env, "delegate"), app.messageBlobId( "draft-1")), null);
	assert.equal(await app.readBlob(jmap(db, env, "delegate"), app.attachmentBlobId( "att-1")), null);
	assert.ok(await app.readBlob(jmap(db, env, "delegate"), app.messageBlobId( "m-1")));
	assert.ok(await app.readBlob(jmap(db, env, "author"), app.messageBlobId( "draft-1")));
	assert.ok(await app.readBlob(jmap(db, env, "author"), app.attachmentBlobId( "att-1")));
});

test("Email/changes and Thread/changes leave out another user's draft but keep paging", async (t) => {
	const { env, db } = await newDatabase(t, seed);
	// The message triggers have logged both inserts (m-1, then the draft).
	const since = async (id) => `c1:0:${(await app.currentChangeScope(jmap(db, env, id))).fingerprint}`;
	const email = await app.emailChangesSince(jmap(db, env, "delegate"), { sinceState: await since("delegate") });
	assert.deepEqual(email.created, ["m-1"]);
	const thread = await app.threadChangesSince(jmap(db, env, "delegate"), { sinceState: await since("delegate") });
	assert.deepEqual(thread.created, ["m-1"]);
	const own = await app.emailChangesSince(jmap(db, env, "author"), { sinceState: await since("author") });
	assert.deepEqual(own.created.sort(), ["draft-1", "m-1"]);
	// A page that holds only the hidden draft still advances the state.
	const page = await app.emailChangesSince(jmap(db, env, "delegate"), { sinceState: await since("delegate"), maxChanges: 1 });
	assert.deepEqual(page.created, ["m-1"]);
	const next = await app.emailChangesSince(jmap(db, env, "delegate"), { sinceState: page.newState, maxChanges: 1 });
	assert.deepEqual(next.created, []);
	assert.equal(next.hasMoreChanges, false);
});

// A scheduled send in a shared mailbox is visible to readers while queued; cancelling it returns it to
// Drafts, where only the author sees it.
const scheduledSeed = `${seed}
	INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at) VALUES
		('sched-1', 'author', 'mb-team', 'outbound', 'team@example.com', 'x@example.net', 'Later', 'body', 'queued', 4);
	INSERT INTO outbound_jobs (id, message_id, user_id, status, payload, scheduled_at, created_at, updated_at) VALUES ('job-1', 'sched-1', 'author', 'queued', '{}', 4102444800, 1, 1);
`;

test("Email/changes tells a reader a cancelled scheduled send is gone, and the author only that it changed", async (t) => {
	const { env, db, sqlite } = await newDatabase(t, scheduledSeed);
	const since = async (id) => `c1:${sqlite.prepare("SELECT max(seq) AS seq FROM jmap_changes").get().seq}:${(await app.currentChangeScope(jmap(db, env, id))).fingerprint}`;
	const delegateSince = await since("delegate");
	const authorSince = await since("author");
	assert.equal(await app.cancelScheduledSend(db, "sched-1"), true);
	const reader = await app.emailChangesSince(jmap(db, env, "delegate"), { sinceState: delegateSince });
	assert.deepEqual(reader.destroyed, ["sched-1"]);
	assert.deepEqual(reader.updated, []);
	const author = await app.emailChangesSince(jmap(db, env, "author"), { sinceState: authorSince });
	assert.deepEqual(author.updated, ["sched-1"]);
	assert.deepEqual(author.destroyed, []);
	// Later edits of the draft stay invisible to the reader.
	const afterCancel = await since("delegate");
	sqlite.prepare("UPDATE messages SET subject = 'Edited' WHERE id = 'sched-1'").run();
	const later = await app.emailChangesSince(jmap(db, env, "delegate"), { sinceState: afterCancel });
	assert.deepEqual([...later.created, ...later.updated, ...later.destroyed], []);
});

test("Mailbox counts leave out another user's draft and Mailbox/changes ignores its activity", async (t) => {
	const { env, db, sqlite } = await newDatabase(t, seed);
	const totals = async (id) => {
		const list = (await app.buildAllMailboxes(jmap(db, env, id))).find((mailbox) => mailbox.name === "Drafts" && String(mailbox.id).includes("mb-team")) ?? null;
		return list?.totalEmails;
	};
	assert.equal(await totals("delegate"), 0);
	assert.equal(await totals("author"), 1);
	const since = async (id) => `c1:${sqlite.prepare("SELECT max(seq) AS seq FROM jmap_changes").get().seq}:${(await app.currentChangeScope(jmap(db, env, id))).fingerprint}`;
	const delegateSince = await since("delegate");
	const authorSince = await since("author");
	sqlite.prepare("UPDATE messages SET subject = 'Edited' WHERE id = 'draft-1'").run();
	const reader = await app.mailboxChangesSince(jmap(db, env, "delegate"), { sinceState: delegateSince });
	assert.deepEqual([...reader.created, ...reader.updated, ...reader.destroyed], []);
	const author = await app.mailboxChangesSince(jmap(db, env, "author"), { sinceState: authorSince });
	assert.ok(author.updated.length > 0);
});
