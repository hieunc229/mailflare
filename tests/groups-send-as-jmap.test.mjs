import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("groups-send-as-jmap", `
	export { identityGet, emailSubmissionSet } from "./src/lib/jmap/identities.ts";
	export { identityId } from "./src/lib/jmap/ids.ts";
`);

const seed = `
	INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES
		('admin', 'admin@example.com', 'hash', 'Admin', 'admin', 1),
		('alice', 'alice@example.com', 'hash', 'Alice Doe', 'user', 1),
		('bob', 'bob@example.com', 'hash', 'Bob', 'user', 1);
	INSERT INTO domains (id, user_id, hostname, zone_id, status, sending_provider, created_at) VALUES ('d1', 'admin', 'example.com', 'z1', 'active', 'cloudflare', 1);
	INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES
		('m-alice', 'alice', 'd1', 'alice', 'personal', 1), ('m-bob', 'bob', 'd1', 'bob', 'personal', 1);
	INSERT INTO license_settings (id, instance_id, plan, state, updated_at) VALUES ('default', 'inst', 'team', 'active', 1);
	INSERT INTO mail_groups (id, domain_id, local_part, name, created_at, updated_at) VALUES ('g1', 'd1', 'team', 'Team', 1, 1);
	INSERT INTO mail_group_members (id, group_id, kind, user_id, can_send_as, created_at) VALUES ('a', 'g1', 'user', 'alice', 1, 1), ('b', 'g1', 'user', 'bob', 0, 1);
	INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, read, created_at) VALUES
		('d-alice', 'alice', 'm-alice', 'outbound', 'alice@example.com', 'x@example.net', 'Hi', 'hello', 'draft', 1, 1),
		('d-bob', 'bob', 'm-bob', 'outbound', 'bob@example.com', 'x@example.net', 'Hi', 'hello', 'draft', 1, 1);
`;
async function fixture(t) {
	const database = await newDatabase(t, seed);
	const sent = [];
	Object.assign(database.env, {
		BUCKET: { put: async () => undefined, get: async () => null, delete: async () => undefined, head: async () => null },
		EMAIL: { send: async (message) => { sent.push(message); return { messageId: `<out-${sent.length}@example.com>` }; } },
		OUTBOUND_QUEUE: { send: async () => undefined },
	});
	const context = (id) => ({
		env: database.env, db: database.db, accountId: id, origin: "http://localhost", createdIds: {}, memo: undefined,
		auth: { userId: id, user: { id, email: `${id}@example.com`, role: "user" }, scopes: ["jmap"], mailboxIds: null },
	});
	return { ...database, sent, context };
}
const submit = (f, user, draft, mailbox, address) => app.emailSubmissionSet(f.context(user), { create: { s1: { emailId: draft, identityId: app.identityId(mailbox, address) } } });

test("Identity/get offers the group to a flagged member on their primary mailbox only", async (t) => {
	const f = await fixture(t);
	const emails = async (user) => (await app.identityGet(f.context(user), {})).list.map((item) => item.email);
	assert.deepEqual(await emails("alice"), ["alice@example.com", "team@example.com"]);
	assert.deepEqual(await emails("bob"), ["bob@example.com"]);
});

test("the group identity carries the group's name, the personal one the mailbox's", async (t) => {
	const f = await fixture(t);
	f.sqlite.exec("UPDATE mailboxes SET display_name = 'Alice Doe' WHERE id = 'm-alice'");
	const list = (await app.identityGet(f.context("alice"), {})).list;
	assert.deepEqual(list.map((item) => [item.email, item.name]), [["alice@example.com", "Alice Doe"], ["team@example.com", "Team"]]);
});

test("EmailSubmission/set sends as the group for a flagged member and refuses everyone else", async (t) => {
	const f = await fixture(t);
	const ok = await submit(f, "alice", "d-alice", "m-alice", "team@example.com");
	assert.ok(ok.created.s1, JSON.stringify(ok.notCreated));
	assert.equal(f.sent.length, 1);
	const refused = await submit(f, "bob", "d-bob", "m-bob", "team@example.com");
	assert.equal(refused.notCreated.s1.type, "forbidden");
	assert.match(refused.notCreated.s1.description, /Sender address does not match/);
	assert.equal(f.sent.length, 1, "no mail left for the refused member");
});
