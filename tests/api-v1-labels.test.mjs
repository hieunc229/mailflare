import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

// The public API can see labels with `read` and change them only with `labels:write`, and a key
// never does more than its user's mailbox permission or its own mailbox list allows.
const mocks = {
	"@/lib/cloudflare": "export function getEnv(){return globalThis.labelEnv}",
	"@/lib/auth/cookies": "export async function getCurrentUser(){return globalThis.labelUser}",
	"@/lib/api/auth": "export async function authenticateApiKey(){return globalThis.labelAuth} export function requireScope(scopes, scope){return scopes.includes(scope) || scopes.includes('*')}",
};
const { app, newDatabase } = await loadApp("api-v1-labels", `
	export * as list from "./src/app/api/v1/labels/route.ts";
	export * as onMessage from "./src/app/api/v1/messages/[id]/labels/route.ts";
	export * as change from "./src/app/api/v1/messages/[id]/labels/[labelId]/route.ts";
	export * as messages from "./src/app/api/v1/messages/route.ts";
	export * as star from "./src/app/api/messages/[messageId]/star/route.ts";
`, { mocks });

const seed = (permission = "read_only") => `${sharedMailboxSeed(permission)}
	INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, thread_id, created_at) VALUES
		('m-1', 'admin', 'mb-team', 'inbound', 'x@example.net', 'team@example.com', 'Order', 'received', 't1', 2),
		('m-2', 'admin', 'mb-team', 'inbound', 'x@example.net', 'team@example.com', 'Re: Order', 'received', 't1', 3),
		('m-3', 'admin', 'mb-team', 'inbound', 'x@example.net', 'team@example.com', 'Other', 'received', 't2', 4);
	INSERT INTO labels (id, mailbox_id, name, color, created_at) VALUES
		('lbl-orders', 'mb-team', 'Orders', '#16a34a', 1),
		('lbl-mine', 'mb-delegate', 'Mine', '#2563eb', 1);
`;
const user = (id) => ({ id, email: `${id}@example.com`, role: "user", disabled: false });
async function setup(t, who, scopes, mailboxIds = null, permission = "read_only") {
	const { env, sqlite } = await newDatabase(t, seed(permission));
	globalThis.labelEnv = env;
	globalThis.labelUser = who ? user(who) : null;
	globalThis.labelAuth = who ? { userId: who, user: user(who), scopes, mailboxIds, keyId: "k", keyKind: "legacy", email: `${who}@example.com` } : null;
	return { sqlite };
}
const request = (path, method = "GET") => new Request(`http://localhost${path}`, { method });
const onConversation = (id) => ({ params: Promise.resolve({ id }) });
const withLabel = (id, labelId) => ({ params: Promise.resolve({ id, labelId }) });
const names = (body) => body.labels.map((label) => label.name);

test("a key without credentials gets 401, and a read key sees labels but cannot change them", async (t) => {
	await setup(t, null, []);
	assert.equal((await app.list.GET(request("/api/v1/labels"))).status, 401);

	await setup(t, "delegate", ["read"]);
	const all = await (await app.list.GET(request("/api/v1/labels?mailboxId=mb-team"))).json();
	assert.deepEqual(names(all), ["Orders"]);
	const denied = await app.change.PUT(request("/x", "PUT"), withLabel("m-1", "lbl-orders"));
	assert.equal(denied.status, 403);
	assert.match((await denied.json()).error, /labels:write/);
	assert.equal((await app.change.DELETE(request("/x", "DELETE"), withLabel("m-1", "lbl-orders"))).status, 403);
});

test("labels:write puts a label on the whole conversation and takes it off, moving nothing", async (t) => {
	const { sqlite } = await setup(t, "author", ["read", "labels:write"]);
	const put = await app.change.PUT(request("/x", "PUT"), withLabel("m-2", "lbl-orders"));
	assert.equal(put.status, 200);
	assert.deepEqual(names(await put.json()), ["Orders"]);

	// The label is on the conversation, so it shows from the other email and on the list.
	assert.deepEqual(names(await (await app.onMessage.GET(request("/x"), onConversation("m-1"))).json()), ["Orders"]);
	const listed = (await (await app.messages.GET(request("/api/v1/messages?mailboxId=mb-team"))).json()).messages;
	assert.deepEqual(listed.filter((row) => row.labels).map((row) => row.id).sort(), ["m-1", "m-2"]);
	assert.equal(listed.find((row) => row.id === "m-3").labels, undefined);
	assert.deepEqual(sqlite.prepare("SELECT DISTINCT status, folder_id FROM messages").all(), [{ status: "received", folder_id: null }]);

	const removed = await app.change.DELETE(request("/x", "DELETE"), withLabel("m-1", "lbl-orders"));
	assert.equal(removed.status, 200);
	assert.deepEqual((await removed.json()).labels, []);
});

test("a key cannot do more than its user's mailbox permission", async (t) => {
	await setup(t, "delegate", ["read", "labels:write"]);
	const response = await app.change.PUT(request("/x", "PUT"), withLabel("m-1", "lbl-orders"));
	assert.equal(response.status, 403, "a read-only member cannot label, even with a labels:write key");
	assert.deepEqual(names(await (await app.onMessage.GET(request("/x"), onConversation("m-1"))).json()), [], "nothing was applied");
});

test("a key limited to other mailboxes sees and changes nothing in this one", async (t) => {
	await setup(t, "author", ["read", "labels:write"], ["mb-delegate"]);
	assert.equal((await app.list.GET(request("/api/v1/labels?mailboxId=mb-team"))).status, 404);
	assert.equal((await app.onMessage.GET(request("/x"), onConversation("m-1"))).status, 404);
	assert.equal((await app.change.PUT(request("/x", "PUT"), withLabel("m-1", "lbl-orders"))).status, 404);
});

test("a label of another mailbox is refused, and the unfiltered list covers every mailbox the key can read", async (t) => {
	await setup(t, "author", ["read", "labels:write"]);
	assert.equal((await app.change.PUT(request("/x", "PUT"), withLabel("m-1", "lbl-mine"))).status, 404);
	assert.equal((await app.change.PUT(request("/x", "PUT"), withLabel("m-1", "missing"))).status, 404);
	assert.deepEqual(names(await (await app.list.GET(request("/api/v1/labels"))).json()), ["Orders"], "the author has no access to mb-delegate");
});

test("applying a label takes exactly the permission the star takes, at every access level", async (t) => {
	for (const permission of ["read_only", "send_as", "send_on_behalf", "full_access"]) {
		await setup(t, "delegate", ["read", "labels:write"], null, permission);
		const star = await app.star.POST(request("/x", "POST"), { params: Promise.resolve({ messageId: "m-1" }) });
		const label = await app.change.PUT(request("/x", "PUT"), withLabel("m-1", "lbl-orders"));
		assert.equal(label.status, star.status, `${permission}: star ${star.status}, label ${label.status}`);
	}
	await setup(t, "delegate", ["read", "labels:write"], null, "read_only");
	assert.equal((await app.star.POST(request("/x", "POST"), { params: Promise.resolve({ messageId: "m-1" }) })).status, 403, "the floor is above read-only");
});
