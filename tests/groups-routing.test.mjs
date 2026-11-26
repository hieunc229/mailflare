import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("groups-routing", `
	export * as policy from "./src/lib/groups/policy-utils.ts";
	export * as loop from "./src/lib/groups/loop-utils.ts";
	export * as memberPolicy from "./src/lib/groups/policy.ts";
	export { resolveInboundAddress } from "./src/lib/email/routing.ts";
	export { resolveIncomingMail } from "./src/lib/email/incoming.ts";
	export { getMailboxDomainAddresses } from "./src/lib/mailboxes/domain-addresses.ts";
	export { getAccountForwardingDestination } from "./src/lib/email/account-forwarding.ts";
`);

const seed = (plan = "team") => `
	INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES
		('admin', 'admin@example.com', 'hash', 'Admin', 'admin', 1),
		('alice', 'alice@example.com', 'hash', 'Alice', 'user', 1);
	INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES
		('d1', 'admin', 'example.com', 'z1', 'active', 1),
		('d2', 'admin', 'other.com', 'z2', 'active', 1);
	INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, use_all_domains, created_at) VALUES
		('m-alice', 'alice', 'd1', 'alice', 'personal', 0, 1),
		('m-support', 'admin', 'd1', 'support', 'shared', 0, 1),
		('m-all', 'admin', 'd1', 'everywhere', 'personal', 1, 1);
	INSERT INTO mailbox_aliases (id, mailbox_id, domain_id, local_part, enabled, masked, created_at) VALUES
		('al1', 'm-alice', 'd1', 'ally', 1, 0, 1);
	INSERT INTO mail_groups (id, domain_id, local_part, name, who_can_post, reply_to, disabled, created_at, updated_at) VALUES
		('g-team', 'd1', 'team', 'Team', 'anyone', 'sender', 0, 1, 1),
		('g-off', 'd1', 'off', 'Off', 'anyone', 'sender', 1, 1, 1),
		('g-members', 'd1', 'staff', 'Staff', 'members', 'sender', 0, 1, 1),
		('g-org', 'd1', 'org', 'Org', 'org', 'sender', 0, 1, 1),
		('g-dup', 'd1', 'everywhere2', 'Dup', 'anyone', 'sender', 0, 1, 1);
	INSERT INTO mail_group_members (id, group_id, kind, user_id, mailbox_id, email, can_send_as, created_at) VALUES
		('gm1', 'g-members', 'user', 'alice', NULL, NULL, 0, 1),
		('gm2', 'g-members', 'mailbox', NULL, 'm-support', NULL, 0, 1),
		('gm3', 'g-members', 'external', NULL, NULL, 'acct@ext.com', 0, 1);
	INSERT INTO license_settings (id, instance_id, plan, state, updated_at) VALUES ('default', 'inst', '${plan}', 'active', 1);
`;
const allow = { allowGroups: async () => true };
const route = (db, to, from = "bob@gmail.com") => app.resolveInboundAddress(db, to, from, allow);

test("a group address resolves to action group", async (t) => {
	const { db } = await newDatabase(t, seed());
	const decision = await route(db, "team@example.com");
	assert.equal(decision.action, "group");
	assert.deepEqual(decision.group, { groupId: "g-team", domainId: "d1", address: "team@example.com", name: "Team", whoCanPost: "anyone", replyTo: "sender" });
	const dotted = await route(db, "T.eam+x@Example.com");
	assert.equal(dotted.group.groupId, "g-team");
});

test("a disabled group rejects with Group unavailable", async (t) => {
	const { db } = await newDatabase(t, seed());
	assert.deepEqual(await route(db, "off@example.com"), { action: "reject", rejectReason: "Group unavailable" });
});

test("mailbox and alias win over a group; phase 1 reject rules still run first", async (t) => {
	const { db, sqlite } = await newDatabase(t, seed());
	assert.equal((await route(db, "alice@example.com")).action, "store");
	assert.equal((await route(db, "ally@example.com")).action, "store");
	sqlite.exec(`INSERT INTO routing_rules (id, user_id, domain_id, scope, action, pattern, match_field, match_operator, priority, enabled, created_at) VALUES ('r1','admin','d1','domain','reject','spam@bad.com','sender','exact',0,1,1)`);
	assert.equal((await route(db, "team@example.com", "spam@bad.com")).action, "reject");
});

test("a catch-all store rule does not receive group mail", async (t) => {
	const { db, sqlite } = await newDatabase(t, seed());
	sqlite.exec(`INSERT INTO routing_rules (id, user_id, domain_id, mailbox_id, scope, action, pattern, match_field, match_operator, priority, enabled, created_at) VALUES ('r2','admin','d1','m-support','domain','store','*','recipient','contains',0,1,1)`);
	assert.equal((await route(db, "team@example.com")).action, "group");
	assert.equal((await route(db, "nobody@example.com")).action, "store");
});

test("a group wins over a use-all-domains mailbox on the same address", async (t) => {
	const { db, sqlite } = await newDatabase(t, seed());
	sqlite.exec(`INSERT INTO mail_groups (id, domain_id, local_part, name, who_can_post, reply_to, disabled, created_at, updated_at) VALUES ('g-all', 'd2', 'everywhere', 'All', 'anyone', 'sender', 0, 1, 1)`);
	assert.equal((await route(db, "everywhere@other.com")).action, "group");
	assert.equal((await route(db, "everywhere@example.com")).action, "store");
});

test("groups are ignored without the entitlement and before the migration", async (t) => {
	const { db, sqlite } = await newDatabase(t, seed());
	assert.equal(await app.resolveInboundAddress(db, "team@example.com", "bob@gmail.com", { allowGroups: async () => false }), null);
	assert.equal(await app.resolveInboundAddress(db, "off@example.com", "bob@gmail.com"), null);
	sqlite.exec("DROP TABLE mail_group_members; DROP TABLE mail_groups;");
	assert.equal(await route(db, "team@example.com"), null);
});

test("getMailboxDomainAddresses treats a group local part as taken", async (t) => {
	const { db, sqlite } = await newDatabase(t, seed());
	sqlite.exec(`INSERT INTO mail_groups (id, domain_id, local_part, name, who_can_post, reply_to, disabled, created_at, updated_at) VALUES ('g-all', 'd2', 'every.where', 'All', 'anyone', 'sender', 0, 1, 1)`);
	const row = sqlite.prepare("SELECT id, domain_id AS domainId, local_part AS localPart FROM mailboxes WHERE id = 'm-all'").get();
	const addresses = await app.getMailboxDomainAddresses(db, { ...row, useAllDomains: true });
	assert.deepEqual(addresses, ["everywhere@example.com"]);
});

test("canPost enforces who can post on a trusted DMARC pass", () => {
	const base = { orgHostnames: ["example.com"], memberAddresses: new Set(["alice@example.com", "acct@ext.com"]) };
	const can = (over) => app.policy.canPost({ whoCanPost: "anyone", senderAddress: "bob@gmail.com", dmarc: undefined, ...base, ...over });
	assert.equal(can({}), true);
	assert.equal(can({ whoCanPost: "org", senderAddress: "ceo@example.com", dmarc: "pass" }), true);
	assert.equal(can({ whoCanPost: "org", senderAddress: "ceo@example.com", dmarc: "fail" }), false);
	assert.equal(can({ whoCanPost: "org", senderAddress: "ceo@example.com", dmarc: undefined }), false);
	assert.equal(can({ whoCanPost: "org", senderAddress: "bob@gmail.com", dmarc: "pass" }), false);
	assert.equal(can({ whoCanPost: "org", senderAddress: "Name <CEO@Example.COM>", dmarc: "pass" }), true);
	assert.equal(can({ whoCanPost: "members", senderAddress: "acct@ext.com", dmarc: "pass" }), true);
	assert.equal(can({ whoCanPost: "members", senderAddress: "acct@ext.com", dmarc: "fail" }), false);
	assert.equal(can({ whoCanPost: "members", senderAddress: "bob@gmail.com", dmarc: "pass" }), false);
	assert.equal(can({ whoCanPost: "members", senderAddress: "", dmarc: "pass" }), false);
	assert.equal(app.policy.GROUP_POST_REJECT_REASON, "5.7.1 You are not allowed to post to this group");
});

test("loop guards drop on group marker, list id, auto-submitted and hop count", () => {
	const guard = { groupId: "g-team", listIdentifier: "team.example.com" };
	const drop = (headers, receivedHops = 1) => app.loop.groupDropReason({ ...guard, headers, receivedHops });
	assert.equal(drop({}), null);
	assert.equal(drop({ "auto-submitted": "no" }), null);
	assert.equal(drop({ "x-mailflare-group": "other" }), null);
	assert.ok(drop({ "x-mailflare-group": "g-team" }));
	assert.ok(drop({ "list-id": "Team <team.example.com>" }));
	assert.equal(drop({ "list-id": "Other <other.example.com>" }), null);
	assert.ok(drop({ "auto-submitted": "auto-replied" }));
	assert.ok(drop({ "Auto-Submitted": "Auto-Replied" }));
	// Alerts, invoices and tickets (auto-generated) must reach alerts@/billing@ groups.
	assert.equal(drop({ "Auto-Submitted": "auto-generated" }), null);
	// Bounces: multipart/report, a null Return-Path, or a null envelope sender.
	assert.ok(drop({ "content-type": 'multipart/report; report-type=delivery-status; boundary="x"' }));
	assert.ok(drop({ "return-path": "<>" }));
	assert.ok(app.loop.groupDropReason({ ...guard, headers: {}, receivedHops: 1, envelopeFrom: "" }));
	assert.ok(app.loop.groupDropReason({ ...guard, headers: {}, receivedHops: 1, envelopeFrom: "<>" }));
	assert.equal(app.loop.groupDropReason({ ...guard, headers: {}, receivedHops: 1, envelopeFrom: "bob@gmail.com" }), null);
	assert.ok(drop({}, 31));
	assert.equal(drop({}, 30), null);
	assert.equal(app.loop.groupListIdentifier("Team", "Example.com"), "team.example.com");
});

test("received hops are counted from the raw header block and from a joined header", () => {
	const raw = new TextEncoder().encode("Received: a\r\n b\r\nReceived: c\r\nSubject: x\r\n\r\nReceived: not a header\r\n").buffer;
	assert.equal(app.loop.countReceivedHeaders(raw), 2);
	const joined = "from a by b; Thu, 26 Nov 2026 10:00:00 +0000, from c by d; Thu, 26 Nov 2026 10:00:01 +0000";
	assert.equal(app.loop.countReceivedInJoinedValue(joined), 2);
	assert.equal(app.loop.countReceivedInJoinedValue(undefined), 0);
});

const incoming = (db, env, to, headers = {}, extra = {}) => app.resolveIncomingMail(env, "bob@gmail.com", to, { all: headers, ...extra });
const pass = { "authentication-results": "mx.cloudflare.net; dmarc=pass header.from=example.com" };

test("resolveIncomingMail accepts, rejects or drops group mail", async (t) => {
	const { db, env, sqlite } = await newDatabase(t, seed());
	assert.equal((await incoming(db, env, "team@example.com")).action, "group");
	// org: spoofed internal From without a pass is rejected.
	const spoof = await incoming(db, env, "org@example.com", { from: "ceo@example.com" });
	assert.deepEqual(spoof, { action: "reject", rejectReason: "5.7.1 You are not allowed to post to this group", groupPolicy: true });
	assert.equal((await incoming(db, env, "org@example.com", { from: "ceo@example.com", ...pass })).action, "group");
	// A From header with several addresses never counts as an insider.
	assert.equal((await incoming(db, env, "org@example.com", { from: "bob@gmail.com, ceo@example.com", ...pass })).action, "reject");
	assert.equal((await incoming(db, env, "org@example.com", { from: "Bob <bob@gmail.com>, CEO <ceo@example.com>", ...pass })).action, "reject");
	assert.equal((await incoming(db, env, "staff@example.com", { from: "bob@gmail.com, alice@example.com", ...pass })).action, "reject");
	assert.equal((await incoming(db, env, "staff@example.com", { from: "alice@example.com, bob@gmail.com", ...pass })).action, "reject");
	assert.equal((await incoming(db, env, "org@example.com", { from: "bob@gmail.com", ...pass }, {})).groupPolicy, true);
	// members: member passes, stranger rejected.
	assert.equal((await incoming(db, env, "staff@example.com", { from: "alice@example.com", ...pass })).action, "group");
	assert.equal((await incoming(db, env, "staff@example.com", { from: "ally@example.com", ...pass })).action, "group");
	assert.equal((await incoming(db, env, "staff@example.com", { from: "support@example.com", ...pass })).action, "group");
	assert.equal((await incoming(db, env, "staff@example.com", { from: "acct@ext.com", ...pass })).action, "group");
	assert.equal((await incoming(db, env, "staff@example.com", { from: "bob@gmail.com", ...pass })).action, "reject");
	assert.equal((await incoming(db, env, "staff@example.com", { from: "alice@example.com" })).action, "reject");
	// loops: dropped silently, not rejected.
	assert.deepEqual(await incoming(db, env, "team@example.com", { "x-mailflare-group": "g-team" }), { action: "drop" });
	assert.deepEqual(await incoming(db, env, "team@example.com", { "auto-submitted": "auto-replied" }), { action: "drop" });
	assert.equal((await incoming(db, env, "team@example.com", { "auto-submitted": "auto-generated" })).action, "group");
	assert.deepEqual(await app.resolveIncomingMail(env, "", "team@example.com", { all: {} }), { action: "drop" });
	assert.deepEqual(await incoming(db, env, "team@example.com", {}, { receivedHops: 31 }), { action: "drop" });
	// verdicts (SES / SMTP) count as trusted too.
	assert.equal((await incoming(db, env, "org@example.com", { from: "ceo@example.com" }, { verdicts: { dmarc: "PASS" } })).action, "group");
	// without the licence a group address is an unknown address.
	sqlite.exec("UPDATE license_settings SET plan = 'community'");
	assert.equal(await incoming(db, env, "team@example.com"), null);
});

test("a policy refusal is flagged so SMTP can drop it when other recipients share the message", async (t) => {
	const { db, env } = await newDatabase(t, seed());
	const refused = await incoming(db, env, "org@example.com", { from: "bob@gmail.com" });
	assert.equal(refused.action, "reject");
	assert.equal(refused.groupPolicy, true);
	const unavailable = await app.resolveInboundAddress(db, "off@example.com", "x@y.com", allow);
	assert.equal(unavailable.groupPolicy, undefined);
});

test("account forwarding never forwards group mail, even past a catch-all", async (t) => {
	const { sqlite, env } = await newDatabase(t, seed());
	sqlite.exec(`
		UPDATE users SET forwarding_email = 'away@ext.com' WHERE id = 'alice';
		INSERT INTO routing_rules (id, user_id, domain_id, mailbox_id, scope, action, pattern, match_field, match_operator, priority, enabled, created_at) VALUES ('r2','admin','d1','m-alice','domain','store','*','recipient','contains',0,1,1);
	`);
	assert.equal(await app.getAccountForwardingDestination(env, "nobody@example.com"), "away@ext.com");
	assert.equal(await app.getAccountForwardingDestination(env, "staff@example.com"), null);
});
