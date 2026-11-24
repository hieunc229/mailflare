import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

// Usage is gated like the mailbox manage actions, so the route runs against the real
// access path with the session user stubbed out.
const mocks = {
	"@/lib/cloudflare": "export function getEnv(){return globalThis.usageEnv}",
	"@/lib/auth/cookies": "export async function requireUser(){return globalThis.usageUser}",
};
const { app, newDatabase } = await loadApp("mailbox-usage", `
	export { getMailboxUsage } from "./src/lib/mailboxes/usage.ts";
	export * as usage from "./src/app/api/mailboxes/[id]/usage/route.ts";
`, { mocks });

const seed = `
	INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, can_manage_users, created_at) VALUES
		('admin', 'admin@example.com', 'hash', 'Admin', 'admin', 1, 0, 1),
		('owner', 'owner@example.com', 'hash', 'Owner', 'user', 0, 0, 1),
		('delegate', 'delegate@example.com', 'hash', 'Delegate', 'user', 0, 0, 1);
	INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES
		('domain-1', 'admin', 'example.com', 'zone-1', 'active', 1);
	INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES
		('mb-full', 'owner', 'domain-1', 'full', 'personal', 1),
		('mb-empty', 'owner', 'domain-1', 'empty', 'personal', 1),
		('mb-team', 'admin', 'domain-1', 'team', 'shared', 1);
	INSERT INTO license_settings (id, instance_id, plan, state, updated_at) VALUES ('default', 'inst', 'team', 'active', 1);
	INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES
		('acc-1', 'mb-team', 'delegate', 'read_only', 1);
	INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, text_body, html_body, status, created_at) VALUES
		('msg-1', 'owner', 'mb-full', 'inbound', 'a@x.test', 'full@example.com', 'héllo', '<p>hi</p>', 'received', 1),
		('msg-2', 'owner', 'mb-full', 'outbound', 'full@example.com', 'b@x.test', 'bye', NULL, 'sent', 2),
		('msg-3', 'owner', 'mb-full', 'inbound', 'c@x.test', 'full@example.com', 'junk', NULL, 'trash', 3),
		('msg-other', 'admin', 'mb-team', 'inbound', 'd@x.test', 'team@example.com', 'not counted', NULL, 'received', 4);
	INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, disposition, created_at) VALUES
		('att-1', 'msg-1', 'a.txt', 'text/plain', 10, 'k1', 'attachment', 1),
		('att-2', 'msg-2', 'b.txt', 'text/plain', 5, 'k2', 'inline', 1),
		('att-other', 'msg-other', 'c.txt', 'text/plain', 999, 'k3', 'attachment', 1);
`;
// mb-full: 'héllo' is 6 UTF-8 bytes (proves octet, not character, counting) + 9 + 3 + 4 = 22
// body bytes, 10 + 5 = 15 attachment bytes, 3 messages including the trashed one.
const EXPECTED = { messageCount: 3, bodyBytes: 22, attachmentBytes: 15, totalBytes: 37 };

const users = {
	admin: { id: "admin", role: "admin", isPrimaryAdmin: true, canManageUsers: false },
	owner: { id: "owner", role: "user", isPrimaryAdmin: false, canManageUsers: false },
	delegate: { id: "delegate", role: "user", isPrimaryAdmin: false, canManageUsers: false },
};
const ctx = (id) => ({ params: Promise.resolve({ id }) });
const get = (id) => new Request(`http://localhost/api/mailboxes/${id}/usage`);

async function setup(t, who) {
	const { env, db } = await newDatabase(t, seed);
	globalThis.usageEnv = env;
	globalThis.usageUser = users[who];
	return db;
}

test("getMailboxUsage sums body and attachment bytes across every status", async (t) => {
	const db = await setup(t, "owner");
	assert.deepEqual(await app.getMailboxUsage(db, "mb-full"), EXPECTED);
});

test("getMailboxUsage returns zeros for an empty mailbox", async (t) => {
	const db = await setup(t, "owner");
	assert.deepEqual(await app.getMailboxUsage(db, "mb-empty"), { messageCount: 0, bodyBytes: 0, attachmentBytes: 0, totalBytes: 0 });
});

test("the usage route serves managers and denies everyone else", async (t) => {
	await setup(t, "owner");
	const response = await app.usage.GET(get("mb-full"), ctx("mb-full"));
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.equal(body.mailboxId, "mb-full");
	assert.equal(body.storageUsed, EXPECTED.totalBytes);
	assert.deepEqual(body.breakdown, {
		bodyBytes: EXPECTED.bodyBytes,
		attachmentBytes: EXPECTED.attachmentBytes,
		messageCount: EXPECTED.messageCount,
	});
	assert.ok(!Number.isNaN(Date.parse(body.computedAt)));

	globalThis.usageUser = users.admin;
	assert.equal((await app.usage.GET(get("mb-full"), ctx("mb-full"))).status, 200);
});

test("read grants and strangers cannot read usage", async (t) => {
	await setup(t, "delegate");
	// read_only on the shared mailbox is not manage access, and mb-full is not theirs at all.
	assert.equal((await app.usage.GET(get("mb-team"), ctx("mb-team"))).status, 404);
	assert.equal((await app.usage.GET(get("mb-full"), ctx("mb-full"))).status, 404);
	assert.equal((await app.usage.GET(get("missing"), ctx("missing"))).status, 404);
});
