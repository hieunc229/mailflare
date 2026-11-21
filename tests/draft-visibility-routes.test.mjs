import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

// Other users' drafts stay private on every read route a shared-mailbox reader can reach.
const mocks = {
	"@/lib/cloudflare": "export function getEnv(){return globalThis.draftEnv}",
	"@/lib/auth/cookies": "export async function getCurrentUser(){return globalThis.draftUser}",
	"@/lib/api/auth": "export async function authenticateApiKey(){return globalThis.draftAuth} export function requireScope(){return true}",
};
const { app, newDatabase } = await loadApp("draft-routes", `
	export * as v1 from "./src/app/api/v1/messages/route.ts";
	export * as zip from "./src/app/api/messages/[messageId]/attachments.zip/route.ts";
	export * as original from "./src/app/api/messages/[messageId]/original/route.ts";
	export * as sendStatus from "./src/app/api/messages/[messageId]/send-status/route.ts";
	export * as opens from "./src/app/api/messages/[messageId]/opens/route.ts";
	export * as counts from "./src/app/api/messages/counts/route.ts";
	export { conversationForUser } from "./src/lib/notes/service.ts";
`, { mocks });

const seed = `${sharedMailboxSeed("read_only")}
	INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, raw_r2_key, private_draft, created_at) VALUES
		('m-1', 'admin', 'mb-team', 'inbound', 'x@example.net', 'team@example.com', 'Hello', 'visible', 'received', NULL, 0, 2),
		('draft-1', 'author', 'mb-team', 'outbound', 'team@example.com', 'x@example.net', 'Unsent', 'private text', 'draft', 'drafts/draft-1.eml', 1, 3);
	INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, disposition, created_at) VALUES ('att-1', 'draft-1', 'plan.txt', 'text/plain', 3, 'k1', 'attachment', 1);
`;
const user = (id) => ({ id, email: `${id}@example.com`, role: "user" });
const ctx = () => ({ params: Promise.resolve({ messageId: "draft-1" }) });
async function setup(t, who) {
	const { env, db } = await newDatabase(t, seed);
	env.BUCKET = { get: async () => ({ body: "raw", size: 3 }), head: async () => ({}) };
	globalThis.draftEnv = env;
	globalThis.draftUser = user(who);
	globalThis.draftAuth = { userId: who, scopes: ["read"], mailboxIds: null, keyId: "k" };
	return { env, db };
}
const get = (path) => new Request(`http://localhost${path}`, { headers: { accept: "*/*" } });

test("a reader gets 404 for another user's draft on the by-id routes", async (t) => {
	const { db } = await setup(t, "delegate");
	assert.equal((await app.zip.GET(get("/z"), ctx())).status, 404);
	assert.equal((await app.original.GET(get("/o"), ctx())).status, 404);
	assert.equal((await app.sendStatus.GET(get("/s"), ctx())).status, 404);
	assert.equal((await app.opens.GET(get("/p"), ctx())).status, 404);
	assert.equal(await app.conversationForUser(db, user("delegate"), "draft-1"), null);
});

test("the draft's author still reaches the by-id routes", async (t) => {
	await setup(t, "author");
	assert.equal((await app.original.GET(get("/o"), ctx())).status, 200);
	assert.equal((await app.sendStatus.GET(get("/s"), ctx())).status, 200);
});

test("the API-key list hides another user's draft and keeps the author's own", async (t) => {
	await setup(t, "delegate");
	let body = await (await app.v1.GET(get("/api/v1/messages?mailboxId=mb-team"))).json();
	assert.deepEqual(body.messages.map((row) => row.id), ["m-1"]);
	await setup(t, "author");
	body = await (await app.v1.GET(get("/api/v1/messages?mailboxId=mb-team"))).json();
	assert.deepEqual(body.messages.map((row) => row.id).sort(), ["draft-1", "m-1"]);
});

test("folder counts leave out another user's draft", async (t) => {
	await setup(t, "delegate");
	const delegate = (await (await app.counts.GET(get("/api/messages/counts?mailboxId=mb-team"))).json()).counts;
	await setup(t, "author");
	const author = (await (await app.counts.GET(get("/api/messages/counts?mailboxId=mb-team"))).json()).counts;
	const drafts = (counts) => Object.entries(counts.folders).find(([name]) => /draft/i.test(name))?.[1]?.total ?? 0;
	assert.equal(drafts(delegate), 0);
	assert.equal(drafts(author), 1);
});
