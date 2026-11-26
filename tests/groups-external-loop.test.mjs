import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("groups-external-loop", `
	export * as loop from "./src/lib/groups/loop-utils.ts";
	export { resolveIncomingMail } from "./src/lib/email/incoming.ts";
`);

const seed = `
	INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('admin', 'admin@example.com', 'hash', 'Admin', 'admin', 1);
	INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d1', 'admin', 'example.com', 'z1', 'active', 1);
	INSERT INTO mail_groups (id, domain_id, local_part, name, who_can_post, reply_to, disabled, created_at, updated_at) VALUES
		('g1', 'd1', 'team', 'Team', 'anyone', 'group', 0, 1, 1),
		('g2', 'd1', 'alerts', 'Alerts', 'anyone', 'group', 0, 1, 1);
	INSERT INTO mail_group_members (id, group_id, kind, email, can_send_as, created_at) VALUES
		('m1', 'g1', 'external', 'helpdesk@ext.com', 0, 1),
		('m2', 'g2', 'external', 'other@ext.com', 0, 1);
	INSERT INTO license_settings (id, instance_id, plan, state, updated_at) VALUES ('default', 'inst', 'team', 'active', 1);
`;
const incoming = (env, to, from, headers) => app.resolveIncomingMail(env, from, to, { all: headers, from: headers.from });

test("automated mail is Auto-Submitted other than no, or Precedence auto_reply", () => {
	const automated = app.loop.isAutomatedMail;
	assert.equal(automated({ "Auto-Submitted": "auto-generated" }), true);
	assert.equal(automated({ "auto-submitted": "auto-replied" }), true);
	assert.equal(automated({ precedence: "auto_reply" }), true);
	assert.equal(automated({ "Auto-Submitted": "no" }), false);
	assert.equal(automated({ precedence: "list" }), false);
	assert.equal(automated({}), false);
});

test("an auto-ack from an external member of the same group is dropped, whatever its envelope sender", async (t) => {
	const { env } = await newDatabase(t, seed);
	const ack = { "auto-submitted": "auto-generated", from: "Help Desk <HelpDesk@Ext.com>" };
	assert.deepEqual(await incoming(env, "team@example.com", "helpdesk@ext.com", ack), { action: "drop" });
	assert.deepEqual(await incoming(env, "team@example.com", "bounce+123@tickets.ext.com", ack), { action: "drop" }, "the From header alone identifies the member");
	assert.deepEqual(await incoming(env, "team@example.com", "helpdesk@ext.com", { "auto-submitted": "auto-generated", from: "noreply@tickets.ext.com" }), { action: "drop" }, "so does the envelope sender alone");
	assert.deepEqual(await incoming(env, "team@example.com", "helpdesk@ext.com", { precedence: "auto_reply", from: "helpdesk@ext.com" }), { action: "drop" });
});

test("alerts and invoices still reach the group, and a member's own replies do too", async (t) => {
	const { env } = await newDatabase(t, seed);
	assert.equal((await incoming(env, "team@example.com", "billing@vendor.com", { "auto-submitted": "auto-generated", from: "billing@vendor.com" })).action, "group");
	assert.equal((await incoming(env, "team@example.com", "helpdesk@ext.com", { from: "helpdesk@ext.com" })).action, "group", "a human reply from the member");
	assert.equal((await incoming(env, "team@example.com", "helpdesk@ext.com", { "auto-submitted": "no", from: "helpdesk@ext.com" })).action, "group");
	assert.equal((await incoming(env, "alerts@example.com", "helpdesk@ext.com", { "auto-submitted": "auto-generated", from: "helpdesk@ext.com" })).action, "group", "membership of another group does not count");
});

test("a member of the group is matched only by exact address, not by domain", async (t) => {
	const { env } = await newDatabase(t, seed);
	assert.equal((await incoming(env, "team@example.com", "alerts@ext.com", { "auto-submitted": "auto-generated", from: "alerts@ext.com" })).action, "group");
});
