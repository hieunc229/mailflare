import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

const mocks = {
	"@/lib/email/send": "export const sendEmail = (...args) => globalThis.__submission.send(...args);",
	"@/lib/email/attachments": "export const loadMessageAttachmentContents = async () => [];",
	"@/lib/email/message-cleanup": `export const deleteMessageWithObjects = async (_env, _db, id) => { globalThis.__submission.sqlite.exec("DELETE FROM messages WHERE id = '" + id + "'"); };`,
};
const { app, newDatabase } = await loadApp("jmap-email-submission", `
	export { emailSubmissionSet } from "./src/lib/jmap/identities.ts";
	export { identityId } from "./src/lib/jmap/ids.ts";
	export { SuppressedRecipientError } from "./src/lib/deliverability/suppression-utils.ts";
`, { mocks });

const drafts = `
	INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at) VALUES
		('d-ok', 'delegate', 'mb-team', 'outbound', 'team@example.com', 'x@example.net', 'Hi', 'body', 'draft', 4),
		('d-ai', 'delegate', 'mb-team', 'outbound', 'team@example.com', 'x@example.net', 'AI', 'body', 'draft', 5),
		('d-other', 'admin', 'mb-admin', 'outbound', 'admin@example.com', 'x@example.net', 'Other', 'body', 'draft', 6);
	INSERT INTO agent_draft_metadata (draft_id, mailbox_id, origin, revision, created_at) VALUES ('d-ai', 'mb-team', 'mcp', 1, 1);
`;

const ctx = (db, env) => ({
	env, db, accountId: "acct", origin: "http://localhost", createdIds: {}, memo: undefined,
	auth: { userId: "delegate", user: { id: "delegate", email: "delegate@example.com", role: "user" }, scopes: ["jmap"], mailboxIds: null },
});

/** Runs EmailSubmission/set for one draft; returns the result and the recorded send calls. */
async function setup(t, { permission = "full_access", send } = {}) {
	const { env, db, sqlite } = await newDatabase(t, sharedMailboxSeed(permission) + drafts);
	const calls = [];
	globalThis.__submission = { sqlite, send: send ? async (...args) => { calls.push(args); return send(...args); } : async (...args) => { calls.push(args); return { messageId: "sent-1" }; } };
	const submit = (emailId = "d-ok") => app.emailSubmissionSet(ctx(db, env), { create: { c1: { emailId, identityId: app.identityId("mb-team", "team@example.com") } } });
	const status = (id) => sqlite.prepare("SELECT status FROM messages WHERE id = ?").get(id)?.status;
	return { submit, calls, status, sqlite };
}

test("an unreviewed AI draft is refused", async (t) => {
	const { submit, calls, status } = await setup(t);
	const result = await submit("d-ai");
	assert.equal(result.notCreated.c1.type, "forbidden");
	assert.equal(calls.length, 0);
	assert.equal(status("d-ai"), "draft");
});

test("a draft of another mailbox is refused", async (t) => {
	const { submit, calls } = await setup(t);
	const result = await submit("d-other");
	assert.equal(result.notCreated.c1.type, "invalidProperties");
	assert.deepEqual(result.notCreated.c1.properties, ["emailId"]);
	assert.equal(calls.length, 0);
});

test("a read_only mailbox identity is refused", async (t) => {
	const { submit } = await setup(t, { permission: "read_only" });
	const result = await submit();
	assert.deepEqual(result.notCreated.c1.properties, ["identityId"]);
});

test("a successful submission sends once and removes the draft", async (t) => {
	const { submit, calls, sqlite } = await setup(t);
	const result = await submit();
	assert.equal(result.created.c1.emailId, "sent-1");
	assert.equal(result.created.c1.undoStatus, "final");
	assert.deepEqual(result.__destroyedEmails, ["d-ok"]);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM messages WHERE id = 'd-ok'").get().n, 0);
	assert.equal(calls.length, 1);
	assert.equal(calls[0][1].from, "team@example.com");
});

test("a suppressed recipient maps to invalidRecipients and keeps the draft", async (t) => {
	const { submit, status } = await setup(t, { send: async () => { throw new app.SuppressedRecipientError(["x@example.net"]); } });
	const result = await submit();
	assert.equal(result.notCreated.c1.type, "invalidRecipients");
	assert.deepEqual(result.notCreated.c1.invalidRecipients, ["x@example.net"]);
	assert.equal(status("d-ok"), "draft");
});

test("two parallel submissions of one draft send once", async (t) => {
	const { submit, calls } = await setup(t, { send: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return { messageId: "sent-1" }; } });
	const results = await Promise.all([submit(), submit()]);
	assert.equal(calls.length, 1);
	assert.equal(results.filter((result) => result.created.c1).length, 1);
	const refused = results.find((result) => result.notCreated.c1);
	assert.deepEqual(refused.notCreated.c1.properties, ["emailId"]);
});

test("a failed send puts the draft back", async (t) => {
	const { submit, status } = await setup(t, { send: async () => { throw new Error("provider down"); } });
	const result = await submit();
	assert.equal(result.notCreated.c1.type, "forbidden");
	assert.equal(result.notCreated.c1.description, "provider down");
	assert.equal(status("d-ok"), "draft");
});
