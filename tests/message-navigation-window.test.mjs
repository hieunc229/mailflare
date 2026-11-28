import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

const mocks = {
	"@/lib/cloudflare": "export function getEnv(){return globalThis.navEnv}",
	"@/lib/auth/cookies": "export async function getCurrentUser(){return globalThis.navUser}",
};
const { app, newDatabase } = await loadApp("message-navigation-window", `
	export * as navigation from "./src/app/api/messages/navigation/route.ts";
`, { mocks });

async function get(t, query) {
	const { env, sqlite } = await newDatabase(t, sharedMailboxSeed("read_only"));
	globalThis.navEnv = env;
	globalThis.navUser = { id: "admin", email: "admin@example.com", role: "admin" };
	sqlite.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 40)
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at)
		SELECT 'm' || i, 'admin', 'mb-team', 'inbound', 'a@x.test', 'b@x.test', 's', 'b', 'archived', i FROM n`);
	const response = await app.navigation.GET(new Request(`http://localhost/api/messages/navigation?folder=archived&mailboxId=mb-team&${query}`));
	assert.equal(response.status, 200);
	return response.json();
}

test("no anchor: the list is capped at the window and flags older", async (t) => {
	const body = await get(t, "limit=25");
	assert.equal(body.messages.length, 25);
	assert.equal(body.hasOlder, true);
	assert.equal(body.hasNewer, false);
	assert.equal(body.messages[0].id, "m40");
});

test("anchor not in the folder: same cap", async (t) => {
	const body = await get(t, "limit=25&around=missing");
	assert.equal(body.messages.length, 25);
	assert.equal(body.hasOlder, true);
	assert.equal(body.hasNewer, false);
});

test("a small folder returns everything", async (t) => {
	const body = await get(t, "limit=100");
	assert.equal(body.messages.length, 40);
	assert.equal(body.hasOlder, false);
});
