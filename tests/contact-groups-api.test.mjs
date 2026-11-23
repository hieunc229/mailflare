import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

// F15: the contact-groups management API. A group labels contacts in the
// mailbox owner's address book — every call carries mailboxId and takes the
// contacts mutation gate (canManage), so a send_on_behalf delegate gets the
// same 404 as a stranger while a full-access delegate manages the owner's
// book. Members join by contactId or by email; an unknown address becomes a
// manual contact, mirroring what saving one does in /api/contacts.

const mocks = {
	"@/lib/cloudflare": "export function getEnv(){return globalThis.groupsEnv}",
	"@/lib/auth/cookies": "export async function requireUser(){ if (!globalThis.groupsUser) throw new Error('Unauthorized'); return globalThis.groupsUser }",
};
const { app, newDatabase } = await loadApp("contact-groups", `
	export * as groups from "./src/app/api/contacts/groups/route.ts";
	export * as group from "./src/app/api/contacts/groups/[id]/route.ts";
	export * as members from "./src/app/api/contacts/groups/[id]/members/route.ts";
`, { mocks });

const admin = { id: "admin", role: "admin" };
const delegate = { id: "delegate", role: "user" };
const author = { id: "author", role: "user" };

const contactsSeed = `
	INSERT INTO contacts (id, user_id, email, display_name, source, created_at) VALUES
		('admin:a@x.test', 'admin', 'a@x.test', 'Alice', 'manual', 1),
		('admin:b@x.test', 'admin', 'b@x.test', NULL, 'manual', 1),
		('author:a@x.test', 'author', 'a@x.test', 'Foreign', 'manual', 1);
`;

async function setup(t, user = admin, permission = "full_access") {
	const { env, sqlite, db } = await newDatabase(t, sharedMailboxSeed(permission) + contactsSeed);
	globalThis.groupsEnv = env;
	globalThis.groupsUser = user;
	return { env, sqlite, db };
}

const req = (path, method = "GET", body) => new Request(`https://mail.test${path}`, {
	method,
	headers: { "content-type": "application/json" },
	...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const ctx = (id) => ({ params: Promise.resolve({ id }) });
const create = (body) => app.groups.POST(req("/api/contacts/groups", "POST", body));

test("creating lists and reads a group, and a delegate writes to the owner's book", async (t) => {
	const { sqlite } = await setup(t);
	const created = await create({ mailboxId: "mb-team", name: "Family" });
	assert.equal(created.status, 200);
	const group = (await created.json()).group;
	assert.equal(group.name, "Family");
	assert.equal(group.memberCount, 0);
	assert.deepEqual(sqlite.prepare("SELECT user_id, name FROM contact_groups WHERE id = ?").get(group.id),
		{ user_id: "admin", name: "Family" });

	// A second group sorts after it case-insensitively and both carry counts.
	await create({ mailboxId: "mb-team", name: "agents" });
	sqlite.prepare("INSERT INTO contact_group_members (id, group_id, contact_id, created_at) VALUES ('m1', ?, 'admin:a@x.test', 1)").run(group.id);
	const { groups } = await (await app.groups.GET(req("/api/contacts/groups?mailboxId=mb-team"))).json();
	assert.deepEqual(groups.map((row) => row.name), ["agents", "Family"]);
	assert.equal(groups.find((row) => row.name === "Family").memberCount, 1);

	const detail = await (await app.group.GET(req(`/api/contacts/groups/${group.id}?mailboxId=mb-team`), ctx(group.id))).json();
	assert.equal(detail.group.id, group.id);
	assert.equal(detail.group.memberCount, 1);
	assert.equal(detail.members.length, 1);
	assert.equal(detail.members[0].email, "a@x.test");
	assert.equal(detail.members[0].contactId, "admin:a@x.test");

	// The full-access delegate manages the same book; their create lands on the
	// mailbox owner's user, not their own — exactly like a saved contact.
	globalThis.groupsUser = delegate;
	const byDelegate = await create({ mailboxId: "mb-team", name: "Delegated" });
	assert.equal(byDelegate.status, 200);
	assert.equal((await byDelegate.json()).group.userId, "admin");
});

test("group names refuse duplicates case-insensitively, and validation rejects bad input", async (t) => {
	await setup(t);
	assert.equal((await create({ mailboxId: "mb-team", name: "Family" })).status, 200);
	assert.equal((await create({ mailboxId: "mb-team", name: "Family" })).status, 409);
	// SQLite/PG unique index is case-sensitive; the app-level check is not.
	assert.equal((await create({ mailboxId: "mb-team", name: "family" })).status, 409);

	assert.equal((await create({ name: "NoMailbox" })).status, 400);
	assert.equal((await create({ mailboxId: "mb-team" })).status, 400);
	assert.equal((await create({ mailboxId: "mb-team", name: " " })).status, 400);
	assert.equal((await create({ mailboxId: "mb-team", name: "a\nb" })).status, 400);
	assert.equal((await app.groups.POST(req("/api/contacts/groups", "POST", [1, 2]))).status, 400);
	assert.equal((await create({ mailboxId: "mb-team", name: "x".repeat(101) })).status, 400);
});

test("the management gate turns away strangers and read-only delegates on every route", async (t) => {
	const { sqlite } = await setup(t, admin, "read_only");
	const group = (await (await create({ mailboxId: "mb-team", name: "Family" })).json()).group;
	const member = (await (await app.members.POST(
		req(`/api/contacts/groups/${group.id}/members`, "POST", { mailboxId: "mb-team", contactId: "admin:a@x.test" }),
		ctx(group.id),
	)).json()).members[0];

	// A send_on_behalf delegate reads the shared mailbox's contacts but cannot manage its book.
	globalThis.groupsUser = author;
	for (const res of [
		await app.groups.GET(req("/api/contacts/groups?mailboxId=mb-team")),
		await create({ mailboxId: "mb-team", name: "Theirs" }),
		await app.group.GET(req(`/api/contacts/groups/${group.id}?mailboxId=mb-team`), ctx(group.id)),
		await app.group.PATCH(req(`/api/contacts/groups/${group.id}`, "PATCH", { mailboxId: "mb-team", name: "H" }), ctx(group.id)),
		await app.group.DELETE(req(`/api/contacts/groups/${group.id}?mailboxId=mb-team`, "DELETE"), ctx(group.id)),
		await app.members.GET(req(`/api/contacts/groups/${group.id}/members?mailboxId=mb-team`), ctx(group.id)),
		await app.members.POST(req(`/api/contacts/groups/${group.id}/members`, "POST", { mailboxId: "mb-team", contactId: "admin:b@x.test" }), ctx(group.id)),
		await app.members.DELETE(req(`/api/contacts/groups/${group.id}/members?mailboxId=mb-team&contactId=admin:a@x.test`, "DELETE"), ctx(group.id)),
	]) assert.equal(res.status, 404);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM contact_group_members WHERE group_id = ?").get(group.id).n, 1);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM contacts").get().n, 3);
	assert.ok(member.id, "member row untouched");
});

test("rename and delete: a group leaves its contacts behind and a foreign book is invisible", async (t) => {
	const { sqlite } = await setup(t);
	const group = (await (await create({ mailboxId: "mb-team", name: "Family" })).json()).group;
	await app.members.POST(req(`/api/contacts/groups/${group.id}/members`, "POST", { mailboxId: "mb-team", contactId: "admin:a@x.test" }), ctx(group.id));

	assert.equal((await app.group.PATCH(req(`/api/contacts/groups/${group.id}`, "PATCH", { mailboxId: "mb-team", name: "Family" }), ctx(group.id))).status, 400);
	assert.equal((await app.group.PATCH(req(`/api/contacts/groups/${group.id}`, "PATCH", { mailboxId: "mb-team" }), ctx(group.id))).status, 400);
	await create({ mailboxId: "mb-team", name: "Other" });
	const dup = await app.group.PATCH(req(`/api/contacts/groups/${group.id}`, "PATCH", { mailboxId: "mb-team", name: "other" }), ctx(group.id));
	assert.equal(dup.status, 409);
	const renamed = await app.group.PATCH(req(`/api/contacts/groups/${group.id}`, "PATCH", { mailboxId: "mb-team", name: " Kin " }), ctx(group.id));
	assert.equal(renamed.status, 200);
	assert.equal((await renamed.json()).group.name, "Kin");

	// A group outside the accessed book does not exist to this caller.
	const foreign = await app.group.GET(req(`/api/contacts/groups/${group.id}?mailboxId=mb-delegate`), ctx(group.id));
	assert.equal(foreign.status, 404);

	// Deleting the group removes only its membership rows.
	assert.equal((await app.group.DELETE(req(`/api/contacts/groups/${group.id}?mailboxId=mb-team`, "DELETE"), ctx(group.id))).status, 200);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM contact_groups WHERE id = ?").get(group.id).n, 0);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM contact_group_members WHERE group_id = ?").get(group.id).n, 0);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM contacts WHERE user_id = 'admin'").get().n, 2);
});

test("members join by contactId or email, an unknown address becomes a contact, duplicates conflict", async (t) => {
	const { sqlite } = await setup(t);
	const group = (await (await create({ mailboxId: "mb-team", name: "Family" })).json()).group;
	const call = (m, body, suffix = "") => app.members[m](
		req(`/api/contacts/groups/${group.id}/members${suffix}`, m === "GET" ? "GET" : m, body),
		ctx(group.id),
	);

	// By contactId: joins the book's contact.
	let { members } = await (await call("POST", { mailboxId: "mb-team", contactId: "admin:a@x.test" })).json();
	assert.equal(members.length, 1);
	assert.equal(members[0].displayName, "Alice");
	assert.equal((await call("POST", { mailboxId: "mb-team", contactId: "admin:a@x.test" })).status, 409);

	// By email: normalizes, reuses the contact row, and creates one when the book lacks it.
	({ members } = await (await call("POST", { mailboxId: "mb-team", email: " B@X.Test " })).json());
	assert.equal(members.length, 2);
	assert.equal(members.find((m) => m.email === "b@x.test").contactId, "admin:b@x.test");
	({ members } = await (await call("POST", { mailboxId: "mb-team", email: "new@x.test" })).json());
	assert.equal(members.length, 3);
	const stored = sqlite.prepare("SELECT id, source, display_name FROM contacts WHERE user_id = 'admin' AND email = 'new@x.test'").get();
	assert.equal(stored.source, "manual");
	assert.equal(stored.display_name, null);
	assert.equal(members.find((m) => m.email === "new@x.test").contactId, stored.id);

	// Exactly one of contactId or email is required; a contact from another book is a 404.
	assert.equal((await call("POST", { mailboxId: "mb-team" })).status, 400);
	assert.equal((await call("POST", { mailboxId: "mb-team", contactId: "admin:a@x.test", email: "c@x.test" })).status, 400);
	assert.equal((await call("POST", { mailboxId: "mb-team", email: "not-an-email" })).status, 400);
	assert.equal((await call("POST", { mailboxId: "mb-team", contactId: "author:a@x.test" })).status, 404);
	assert.equal((await call("POST", { mailboxId: "mb-team", contactId: "missing" })).status, 404);
});

test("members leave by contactId or email, and deleting a contact cascades its memberships", async (t) => {
	const { sqlite } = await setup(t);
	const group = (await (await create({ mailboxId: "mb-team", name: "Family" })).json()).group;
	const call = (m, body, suffix = "") => app.members[m](
		req(`/api/contacts/groups/${group.id}/members${suffix}`, m === "GET" ? "GET" : m, body),
		ctx(group.id),
	);
	await call("POST", { mailboxId: "mb-team", contactId: "admin:a@x.test" });
	await call("POST", { mailboxId: "mb-team", contactId: "admin:b@x.test" });

	assert.equal((await call("DELETE", undefined, "?mailboxId=mb-team")).status, 400);
	assert.equal((await call("DELETE", undefined, "?mailboxId=mb-team&contactId=admin:a@x.test&email=b@x.test")).status, 400);
	assert.equal((await call("DELETE", undefined, "?mailboxId=mb-team&contactId=zzz")).status, 404);
	assert.equal((await call("DELETE", undefined, "?mailboxId=mb-team&email=ghost@x.test")).status, 404);

	// By email first, then by contactId: both remove only the membership row.
	let { members } = await (await call("DELETE", undefined, "?mailboxId=mb-team&email=B@x.test")).json();
	assert.deepEqual(members.map((m) => m.email), ["a@x.test"]);
	({ members } = await (await call("DELETE", undefined, "?mailboxId=mb-team&contactId=admin:a@x.test")).json());
	assert.equal(members.length, 0);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM contacts WHERE user_id = 'admin'").get().n, 2);

	// A deleted contact falls out of every group it was in; the group stays.
	await call("POST", { mailboxId: "mb-team", contactId: "admin:a@x.test" });
	const second = (await (await create({ mailboxId: "mb-team", name: "Work" })).json()).group;
	await app.members.POST(
		req(`/api/contacts/groups/${second.id}/members`, "POST", { mailboxId: "mb-team", contactId: "admin:a@x.test" }),
		ctx(second.id),
	);
	sqlite.prepare("DELETE FROM contacts WHERE id = 'admin:a@x.test'").run();
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM contact_group_members").get().n, 0);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM contact_groups WHERE user_id = 'admin'").get().n, 2);
});
