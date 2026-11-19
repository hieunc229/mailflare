import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

// Another user's draft is invisible to a delegate, so no write route may act on it or copy from it.
const mocks = {
	"@/lib/cloudflare": "export function getEnv(){return globalThis.draftEnv}",
	"@/lib/auth/cookies": "export async function getCurrentUser(){return globalThis.draftUser} export async function requireUser(){return globalThis.draftUser}",
};
const { app, newDatabase } = await loadApp("draft-writes", `
	export * as bulk from "./src/app/api/messages/bulk/route.ts";
	export * as actions from "./src/app/api/messages/actions/route.ts";
	export * as star from "./src/app/api/messages/[messageId]/star/route.ts";
	export * as status from "./src/app/api/messages/[messageId]/status/route.ts";
	export * as read from "./src/app/api/messages/[messageId]/read/route.ts";
	export * as drafts from "./src/app/api/drafts/route.ts";
	export { addressesSeenInMailbox } from "./src/app/api/contacts/utils.ts";
`, { mocks });

const seed = `${sharedMailboxSeed("full_access")}
	INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, read, private_draft, created_at) VALUES
		('m-1', 'admin', 'mb-team', 'inbound', 'x@example.net', 'team@example.com', 'Hello', 'visible', 'received', 0, 0, 2),
		('draft-1', 'author', 'mb-team', 'outbound', 'team@example.com', 'secret@example.org', 'Unsent', 'private text', 'draft', 1, 1, 3);
	INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, disposition, created_at) VALUES ('att-1', 'draft-1', 'plan.txt', 'text/plain', 3, 'k1', 'attachment', 1);
`;
const user = (id) => ({ id, email: `${id}@example.com`, role: "user" });
async function setup(t, who) {
	const fixture = await newDatabase(t, seed);
	const objects = new Map();
	fixture.env.BUCKET = {
		get: async (key) => (objects.has(key) ? { body: objects.get(key), size: 3, text: async () => String(objects.get(key)), arrayBuffer: async () => new ArrayBuffer(3) } : null),
		head: async (key) => (objects.has(key) ? {} : null),
		put: async (key, value) => { objects.set(key, value); },
	};
	globalThis.draftEnv = fixture.env;
	globalThis.draftUser = user(who);
	return fixture;
}
const post = (body) => new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ctx = (messageId) => ({ params: Promise.resolve({ messageId }) });
const stateOf = (sqlite) => sqlite.prepare("SELECT status, read, starred, folder_id FROM messages WHERE id = 'draft-1'").get();

test("bulk actions skip another user's draft and still act on visible mail", async (t) => {
	const { sqlite } = await setup(t, "delegate");
	const before = stateOf(sqlite);
	assert.equal((await app.bulk.POST(post({ messageIds: ["draft-1"], action: "trash" }))).status, 404);
	assert.equal((await app.bulk.POST(post({ messageIds: ["draft-1"], action: "unread" }))).status, 404);
	assert.deepEqual(stateOf(sqlite), before);
	assert.equal((await app.bulk.POST(post({ messageIds: ["draft-1", "m-1"], action: "archive" }))).status, 200);
	assert.deepEqual(stateOf(sqlite), before);
	assert.equal(sqlite.prepare("SELECT status FROM messages WHERE id = 'm-1'").get().status, "archived");
});

test("the actions service reports another user's draft as not found", async (t) => {
	const { sqlite } = await setup(t, "delegate");
	const before = stateOf(sqlite);
	const body = await (await app.actions.POST(post({ action: "star", messageIds: ["draft-1", "m-1"] }))).json();
	assert.deepEqual(body.skipped.map((row) => [row.id, row.reason]), [["draft-1", "not_found"]]);
	assert.deepEqual(body.applied.map((row) => row.id), ["m-1"]);
	assert.deepEqual(stateOf(sqlite), before);
});

test("star, status and read refuse another user's draft", async (t) => {
	const { sqlite } = await setup(t, "delegate");
	const before = stateOf(sqlite);
	assert.equal((await app.star.POST(post({}), ctx("draft-1"))).status, 404);
	assert.equal((await app.status.POST(post({ status: "trash" }), ctx("draft-1"))).status, 404);
	assert.equal((await app.read.POST(post({}), ctx("draft-1"))).status, 404);
	assert.deepEqual(stateOf(sqlite), before);
});

test("the author keeps full control of the draft", async (t) => {
	const { sqlite } = await setup(t, "author");
	assert.equal((await app.star.POST(post({}), ctx("draft-1"))).status, 200);
	assert.equal(stateOf(sqlite).starred, 1);
});

test("a draft cannot be forwarded from another user's draft", async (t) => {
	const { sqlite } = await setup(t, "delegate");
	const forward = (forwardOfMessageId) => app.drafts.POST(post({ mailboxId: "mb-delegate", from: "delegate@example.com", to: "x@example.net", forwardOfMessageId }));
	assert.equal((await forward("draft-1")).status, 404);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM message_attachments WHERE message_id != 'draft-1'").get().n, 0);
	assert.equal((await forward("m-1")).status, 200);
});

test("addresses on another user's draft do not make a contact visible to a delegate", async (t) => {
	const { db } = await setup(t, "delegate");
	assert.equal((await app.addressesSeenInMailbox(db, "mb-team", ["secret@example.org"], "delegate")).size, 0);
	assert.equal((await app.addressesSeenInMailbox(db, "mb-team", ["secret@example.org"], "author")).size, 1);
	assert.equal((await app.addressesSeenInMailbox(db, "mb-team", ["x@example.net"], "delegate")).size, 1);
});
