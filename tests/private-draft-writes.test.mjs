import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

// messages.private_draft must be set wherever a row is created or turned into a draft, and cleared
// when the row becomes sent mail; readers of the mailbox are told when a visible message hides.
const mocks = {
	"@/lib/cloudflare": "export function getEnv(){return globalThis.pdEnv}",
	"@/lib/auth/cookies": "export async function requireUser(){return globalThis.pdUser} export async function getCurrentUser(){return globalThis.pdUser}",
};
const { app, newDatabase } = await loadApp("private-draft-writes", `
	export { emailSet } from "./src/lib/jmap/emails.ts";
	export { currentChangeScope, emailChangesSince } from "./src/lib/jmap/changes.ts";
	export { emailQuery } from "./src/lib/jmap/emails.ts";
	export { cancelScheduledSend } from "./src/lib/email/scheduled.ts";
	export { updateMessageStatus, updateMessageStatusForUser } from "./src/lib/user.ts";
	export { importMessagesToMailbox } from "./src/lib/import/service.ts";
	export * as cancelRoute from "./src/app/api/messages/[messageId]/cancel-schedule/route.ts";
	export * as drafts from "./src/app/api/drafts/route.ts";
`, { mocks });

const seed = `${sharedMailboxSeed("full_access")}
	INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, private_draft, created_at) VALUES
		('sent-1', 'author', 'mb-team', 'outbound', 'team@example.com', 'x@example.net', 'Sent one', 'shared text', 'sent', 0, 5),
		('draft-1', 'author', 'mb-team', 'outbound', 'team@example.com', 'x@example.net', 'Unsent', 'private text', 'draft', 1, 6);
`;
const user = (id, role = "user") => ({ id, email: `${id}@example.com`, role });
const jmap = (db, env, id) => ({ env, db, accountId: "acct", origin: "http://localhost", createdIds: {}, memo: undefined, auth: { userId: id, user: user(id), scopes: ["jmap"], mailboxIds: null } });
const flag = (sqlite, id) => sqlite.prepare("SELECT private_draft AS p FROM messages WHERE id = ?").get(id)?.p;

async function setup(t) {
	const fixture = await newDatabase(t, seed);
	fixture.env.BUCKET = { get: async () => ({ body: "x" }), put: async () => {}, delete: async () => {} };
	globalThis.pdEnv = fixture.env;
	return fixture;
}
// The feed position right now, so a test sees only what happens after it.
const since = async (db, env, sqlite, id) => `c1:${sqlite.prepare("SELECT max(seq) AS seq FROM jmap_changes").get().seq}:${(await app.currentChangeScope(jmap(db, env, id))).fingerprint}`;

test("creating a draft over REST marks it private", async (t) => {
	const { sqlite } = await setup(t);
	globalThis.pdUser = user("delegate");
	const response = await app.drafts.POST(new Request("http://localhost/api/drafts", {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ from: "delegate@example.com", mailboxId: "mb-delegate", to: "x@example.net", subject: "Hi", text: "body" }),
	}));
	const body = await response.json();
	assert.equal(response.status, 200, JSON.stringify(body));
	assert.equal(flag(sqlite, (body.draft ?? body).id), 1);
});

test("creating a draft over JMAP marks it private", async (t) => {
	const { env, db, sqlite } = await setup(t);
	const result = await app.emailSet(jmap(db, env, "delegate"), {
		create: { c1: { mailboxIds: { "mb-delegate~drafts": true }, from: [{ email: "delegate@example.com" }], to: [{ email: "x@example.net" }], subject: "Hi", keywords: { $draft: true }, bodyValues: { t: { value: "body" } }, textBody: [{ partId: "t" }] } },
	});
	assert.ok(result.created.c1, JSON.stringify(result));
	assert.equal(flag(sqlite, result.created.c1.id), 1);
});

test("importing into Drafts marks the message private, importing into Sent does not", async (t) => {
	const { env, sqlite } = await setup(t);
	const raw = (id) => new TextEncoder().encode(`From: delegate@example.com\r\nTo: x@example.net\r\nSubject: Imp ${id}\r\nMessage-ID: <${id}@example.com>\r\nDate: Tue, 2 Feb 2021 10:00:00 +0000\r\n\r\nHello`).buffer;
	for (const section of ["drafts", "sent"]) {
		const result = await app.importMessagesToMailbox(env, { userId: "delegate", mailboxId: "mb-delegate", destination: { type: "system", section }, messages: [{ filename: `${section}.eml`, raw: raw(section) }] });
		assert.equal(result.imported, 1, JSON.stringify(result));
	}
	assert.equal(sqlite.prepare("SELECT private_draft AS p FROM messages WHERE subject = 'Imp drafts'").get().p, 1);
	assert.equal(sqlite.prepare("SELECT private_draft AS p FROM messages WHERE subject = 'Imp sent'").get().p, 0);
});

test("cancelling a scheduled send makes the message private and tells readers it is gone", async (t) => {
	const { env, db, sqlite } = await setup(t);
	sqlite.exec(`UPDATE messages SET status = 'queued' WHERE id = 'sent-1';
		INSERT INTO outbound_jobs (id, message_id, user_id, status, payload, scheduled_at, created_at, updated_at) VALUES ('job-1', 'sent-1', 'author', 'queued', '{}', 4102444800, 1, 1);`);
	const reader = await since(db, env, sqlite, "delegate");
	assert.equal(await app.cancelScheduledSend(db, "sent-1"), true);
	assert.equal(flag(sqlite, "sent-1"), 1);
	assert.deepEqual((await app.emailChangesSince(jmap(db, env, "delegate"), { sinceState: reader })).destroyed, ["sent-1"]);
});

test("a status change into Drafts hides a visible message from readers, and into Sent releases it", async (t) => {
	const { env, db, sqlite } = await setup(t);
	const reader = await since(db, env, sqlite, "delegate");
	const author = await since(db, env, sqlite, "author");
	assert.equal(await app.updateMessageStatusForUser(env, user("admin", "admin"), "sent-1", "draft"), true);
	assert.equal(flag(sqlite, "sent-1"), 1);
	const seen = await app.emailChangesSince(jmap(db, env, "delegate"), { sinceState: reader });
	assert.deepEqual(seen.destroyed, ["sent-1"]);
	assert.deepEqual(seen.updated, []);
	const own = await app.emailChangesSince(jmap(db, env, "author"), { sinceState: author });
	assert.deepEqual(own.updated, ["sent-1"]);
	assert.deepEqual(own.destroyed, []);
	assert.ok(!(await app.emailQuery(jmap(db, env, "delegate"), {})).ids.includes("sent-1"));
	// Only the author can still act on it; sending it releases it to the mailbox's readers.
	assert.equal(await app.updateMessageStatusForUser(env, user("admin", "admin"), "sent-1", "sent"), false);
	assert.equal(await app.updateMessageStatus(env, "author", "sent-1", "sent"), true);
	assert.equal(flag(sqlite, "sent-1"), 0);
	assert.ok((await app.emailQuery(jmap(db, env, "delegate"), {})).ids.includes("sent-1"));
});

test("moving a message into Drafts over JMAP hides it from readers, moving a draft to Sent releases it", async (t) => {
	const { env, db, sqlite } = await setup(t);
	const reader = await since(db, env, sqlite, "admin");
	const moved = await app.emailSet(jmap(db, env, "delegate"), { update: { "sent-1": { mailboxIds: { "mb-team~drafts": true } } } });
	assert.deepEqual(moved.updated, { "sent-1": null }, JSON.stringify(moved));
	assert.equal(flag(sqlite, "sent-1"), 1);
	assert.deepEqual((await app.emailChangesSince(jmap(db, env, "admin"), { sinceState: reader })).destroyed, ["sent-1"]);
	const released = await app.emailSet(jmap(db, env, "author"), { update: { "draft-1": { mailboxIds: { "mb-team~sent": true } } } });
	// The author has send_on_behalf only, so the move is refused and the draft stays private.
	assert.equal(released.notUpdated["draft-1"].type, "forbidden");
	assert.equal(flag(sqlite, "draft-1"), 1);
});

test("a colleague cancelling a scheduled send over REST gets a neutral answer and cannot open the draft", async (t) => {
	const { sqlite } = await setup(t);
	sqlite.exec(`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, private_draft, created_at) VALUES ('sched-1', 'author', 'mb-team', 'outbound', 'team@example.com', 'x@example.net', 'Later', 'b', 'queued', 0, 8);
		INSERT INTO outbound_jobs (id, user_id, message_id, status, payload, scheduled_at, created_at, updated_at) VALUES ('job-s', 'author', 'sched-1', 'queued', '{}', 4102444800, 1, 1);`);
	globalThis.pdUser = user("delegate");
	const response = await app.cancelRoute.POST(new Request("http://localhost/x", { method: "POST" }), { params: Promise.resolve({ messageId: "sched-1" }) });
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { ok: true });
	// The row is now the author's private draft: the colleague cannot read it.
	assert.equal(flag(sqlite, "sched-1"), 1);
	const again = await app.cancelRoute.POST(new Request("http://localhost/x", { method: "POST" }), { params: Promise.resolve({ messageId: "sched-1" }) });
	assert.equal(again.status, 404);
});
