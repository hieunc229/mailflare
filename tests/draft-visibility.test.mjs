import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("draft-visibility", `
	export { getMessageWithBodyForUser, getMessageMetadataForUser } from "./src/lib/email/inbound.ts";
	export { getAttachmentForUser } from "./src/lib/email/attachments.ts";
	export { getMessageThreadForUser } from "./src/lib/email/thread-view.ts";
	export { emailGet, emailQuery } from "./src/lib/jmap/emails.ts";
`);

// 'author' (send_on_behalf) wrote the draft in the shared mailbox; 'delegate' can only read it.
const seed = `${sharedMailboxSeed("read_only")}
	INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at) VALUES
		('m-1', 'admin', 'mb-team', 'inbound', 'x@example.net', 'team@example.com', 'Hello', 'visible', 'received', 2),
		('draft-1', 'author', 'mb-team', 'outbound', 'team@example.com', 'x@example.net', 'Unsent', 'private text', 'draft', 3);
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
