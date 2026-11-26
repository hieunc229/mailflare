import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("groups-send-as", `
	export { getAuthorizedSenderAddress } from "./src/lib/email/sender.ts";
	export { findSendAsGroup } from "./src/lib/groups/send-as.ts";
`);

const seed = (plan = "team") => `
	INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES
		('admin', 'admin@example.com', 'hash', 'Admin', 'admin', 1),
		('alice', 'alice@example.com', 'hash', 'Alice Doe', 'user', 1),
		('bob', 'bob@example.com', 'hash', 'Bob', 'user', 1),
		('carol', 'carol@example.com', 'hash', 'Carol', 'user', 1);
	INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d1', 'admin', 'example.com', 'z1', 'active', 1);
	INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES
		('m-alice', 'alice', 'd1', 'alice', 'personal', 1),
		('m-alice2', 'alice', 'd1', 'alice.second', 'personal', 1),
		('m-bob', 'bob', 'd1', 'bob', 'personal', 1),
		('m-carol', 'carol', 'd1', 'carol', 'personal', 1),
		('m-shared', 'admin', 'd1', 'support', 'shared', 1);
	INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('acc-1', 'm-shared', 'alice', 'send_as', 1);
	INSERT INTO license_settings (id, instance_id, plan, state, updated_at) VALUES ('default', 'inst', '${plan}', 'active', 1);
	INSERT INTO mail_groups (id, domain_id, local_part, name, who_can_post, reply_to, disabled, created_at, updated_at) VALUES
		('g1', 'd1', 'team', 'Team', 'anyone', 'sender', 0, 1, 1),
		('g2', 'd1', 'paused', 'Paused', 'anyone', 'sender', 1, 1, 1);
	INSERT INTO mail_group_members (id, group_id, kind, user_id, can_send_as, created_at) VALUES
		('gm1', 'g1', 'user', 'alice', 1, 1),
		('gm2', 'g1', 'user', 'bob', 0, 1),
		('gm3', 'g2', 'user', 'alice', 1, 1);
	INSERT INTO mail_group_members (id, group_id, kind, mailbox_id, can_send_as, created_at) VALUES ('gm4', 'g1', 'mailbox', 'm-shared', 1, 1);
`;
const ctx = async (t, plan) => newDatabase(t, seed(plan));
const send = (c, userId, from, mailboxId) => app.getAuthorizedSenderAddress(c.env, { userId, from, mailboxId });

test("a flagged user member sends as the group from their own primary mailbox, Sent copy in that mailbox", async (t) => {
	const c = await ctx(t);
	const group = { groupId: "g1", name: "Team", address: "team@example.com" };
	assert.deepEqual(await send(c, "alice", "team@example.com", "m-alice"), { fromAddr: "\"Team\" <team@example.com>", mailboxId: "m-alice", group });
	assert.deepEqual(await send(c, "alice", "Team <TEAM@example.com>", "m-alice"), { fromAddr: "\"Team\" <team@example.com>", mailboxId: "m-alice", group });
});

test("a member without the flag, a non-member and an external mailbox owner are refused", async (t) => {
	const c = await ctx(t);
	await assert.rejects(send(c, "bob", "team@example.com", "m-bob"), /Sender address does not match the selected mailbox/);
	await assert.rejects(send(c, "carol", "team@example.com", "m-carol"), /Sender address does not match the selected mailbox/);
	await assert.rejects(send(c, "bob", "team@example.com", "m-alice"), /permission to send/);
});

test("only the exact enabled group address counts: no +tag, no dots, no disabled group", async (t) => {
	const c = await ctx(t);
	for (const from of ["team+x@example.com", "te.am@example.com", "paused@example.com", "ghost@example.com", "team@other.com"]) {
		await assert.rejects(send(c, "alice", from, "m-alice"), /Sender address does not match the selected mailbox/, from);
	}
});

test("only the actor's own primary mailbox may carry the group address", async (t) => {
	const c = await ctx(t);
	await assert.rejects(send(c, "alice", "team@example.com", "m-alice2"), /Sender address does not match the selected mailbox/);
	await assert.rejects(send(c, "alice", "team@example.com", "m-shared"), /Sender address does not match the selected mailbox/);
});

test("without the Pro or Team licence the group address is refused", async (t) => {
	const c = await ctx(t, "free");
	await assert.rejects(send(c, "alice", "team@example.com", "m-alice"), /Sender address does not match the selected mailbox/);
});

test("a disabled account and a removed membership lose the right at once", async (t) => {
	const c = await ctx(t);
	c.sqlite.exec("UPDATE mail_group_members SET can_send_as = 0 WHERE id = 'gm1'");
	await assert.rejects(send(c, "alice", "team@example.com", "m-alice"), /Sender address does not match the selected mailbox/);
	c.sqlite.exec("UPDATE mail_group_members SET can_send_as = 1 WHERE id = 'gm1'; UPDATE users SET disabled = 1 WHERE id = 'alice'");
	await assert.rejects(send(c, "alice", "team@example.com", "m-alice"), /Sender account not found/);
	c.sqlite.exec("UPDATE users SET disabled = 0 WHERE id = 'alice'; DELETE FROM mail_group_members WHERE id = 'gm1'");
	await assert.rejects(send(c, "alice", "team@example.com", "m-alice"), /Sender address does not match the selected mailbox/);
});

test("findSendAsGroup returns only a flagged user member of an enabled group", async (t) => {
	const c = await ctx(t);
	assert.deepEqual(await app.findSendAsGroup(c.db, "alice", "team@example.com"), { groupId: "g1", name: "Team", address: "team@example.com" });
	assert.equal(await app.findSendAsGroup(c.db, "bob", "team@example.com"), null);
	assert.equal(await app.findSendAsGroup(c.db, "alice", "paused@example.com"), null);
	assert.equal(await app.findSendAsGroup(c.db, "alice", "not-an-address"), null);
});

test("before the groups migration nothing can send as a group", async (t) => {
	const c = await ctx(t);
	c.sqlite.exec("DROP TABLE mail_group_members; DROP TABLE mail_groups");
	await assert.rejects(send(c, "alice", "team@example.com", "m-alice"), /Sender address does not match the selected mailbox/);
	assert.equal(await app.findSendAsGroup(c.db, "alice", "team@example.com"), null);
});
