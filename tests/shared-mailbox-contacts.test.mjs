import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("shared-mailbox-contacts", `
	export { GET as getContacts } from "./src/app/api/contacts/route.ts";
	export { GET as getAvatar } from "./src/app/api/contacts/avatar/route.ts";
	export { createSession } from "./src/lib/auth/session.ts";
`);

// The admin owns the shared mailbox "team" and their personal address book; only boss@client.test wrote to team.
const seed = `${sharedMailboxSeed("read_only")}
	INSERT INTO contacts (id, user_id, email, display_name, source, created_at) VALUES
		('c1', 'admin', 'boss@client.test', 'Boss', 'inbound', 1),
		('c2', 'admin', 'spouse@private.test', 'Spouse', 'manual', 1),
		('c3', 'admin', 'vendor@supplier.test', 'Vendor', 'outbound', 1);
	INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, cc_addr, subject, status, created_at) VALUES
		('m1', 'admin', 'mb-team', 'inbound', 'boss@client.test', 'team@example.com', NULL, 'Hi', 'received', 2),
		('m2', 'admin', 'mb-team', 'outbound', 'team@example.com', 'Vendor <vendor@supplier.test>', NULL, 'Re', 'sent', 3),
		('m3', 'admin', 'mb-admin', 'inbound', 'spouse@private.test', 'admin@example.com', NULL, 'Dinner', 'received', 4);
`;

async function request(t, userId, path) {
	const fixture = await newDatabase(t, seed);
	globalThis.__mailflareNodeEnv = fixture.env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const token = await app.createSession(fixture.env, userId);
	return { ...fixture, get: (handler, query) => handler(new Request(`http://localhost${path}?${query}`, { headers: { authorization: `Bearer ${token}` } })) };
}

test("a delegate lists only contacts whose address is on the shared mailbox's mail", async (t) => {
	const { get } = await request(t, "delegate", "/api/contacts");
	const response = await get(app.getContacts, "mailboxId=mb-team");
	assert.deepEqual((await response.json()).contacts.map((c) => c.email).sort(), ["boss@client.test", "vendor@supplier.test"]);
});

test("a delegate cannot look up a personal contact of the owner by address", async (t) => {
	const { get } = await request(t, "delegate", "/api/contacts");
	const hidden = await (await get(app.getContacts, "mailboxId=mb-team&address=spouse@private.test")).json();
	assert.equal(hidden.contact.displayName, null);
	assert.equal(hidden.contact.source, null);
	const shown = await (await get(app.getContacts, "mailboxId=mb-team&address=boss@client.test")).json();
	assert.equal(shown.contact.displayName, "Boss");
});

test("the mailbox owner still sees the whole address book", async (t) => {
	const { get } = await request(t, "admin", "/api/contacts");
	const response = await get(app.getContacts, "mailboxId=mb-team");
	assert.equal((await response.json()).contacts.length, 3);
});

test("a delegate gets no avatar for an address that is not on the shared mailbox", async (t) => {
	const { get, sqlite } = await request(t, "delegate", "/api/contacts/avatar");
	sqlite.exec("UPDATE contacts SET avatar_key = 'avatars/x' WHERE id = 'c2'");
	assert.equal((await get(app.getAvatar, "mailboxId=mb-team&address=spouse@private.test")).status, 404);
});
