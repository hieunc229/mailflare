import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const mocks = { "@/lib/email/auto-reply": "export async function sendMailboxAutoReply(){}" };
const { app, newDatabase } = await loadApp("groups-send-as-marker", `
	export { signSendAs, verifySendAs, isSignedSendAs, SEND_AS_HEADER } from "./src/lib/groups/send-as-marker.ts";
	export { admitGroupMail } from "./src/lib/email/incoming.ts";
	export { expandGroupDelivery } from "./src/lib/groups/expand.ts";
`, { mocks });

const seed = `
	INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES
		('admin', 'admin@example.com', 'hash', 'Admin', 'admin', 1),
		('alice', 'alice@example.com', 'hash', 'Alice', 'user', 1),
		('bob', 'bob@example.com', 'hash', 'Bob', 'user', 1);
	INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d1', 'admin', 'example.com', 'z1', 'active', 1);
	INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES
		('m-alice', 'alice', 'd1', 'alice', 'personal', 1), ('m-bob', 'bob', 'd1', 'bob', 'personal', 1);
	INSERT INTO license_settings (id, instance_id, plan, state, updated_at) VALUES ('default', 'inst', 'team', 'active', 1);
	INSERT INTO mail_groups (id, domain_id, local_part, name, who_can_post, created_at, updated_at) VALUES ('g1', 'd1', 'team', 'Team', 'members', 1, 1), ('g2', 'd1', 'other', 'Other', 'members', 1, 1);
	INSERT INTO mail_group_members (id, group_id, kind, user_id, can_send_as, created_at) VALUES ('gm1', 'g1', 'user', 'alice', 1, 1), ('gm2', 'g1', 'user', 'bob', 0, 1);
	INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, read, created_at) VALUES
		('msg_out1', 'alice', 'm-alice', 'outbound', 'Team <team@example.com>', 'team@example.com', 'Hi', 'sent', 1, unixepoch()),
		('msg_old', 'alice', 'm-alice', 'outbound', 'Team <team@example.com>', 'team@example.com', 'Hi', 'sent', 1, 1);
`;
const PASS = { "authentication-results": "mx.cloudflare.net; dmarc=pass header.from=example.com" };
const group = (over = {}) => ({ action: "group", group: { groupId: "g1", domainId: "d1", address: "team@example.com", name: "Team", whoCanPost: "members", replyTo: "sender", ...over } });

async function fixture(t) {
	const database = await newDatabase(t, seed);
	const objects = new Map();
	const queue = [];
	const env = {
		...database.env,
		MAILFLARE_RUNTIME: "node",
		BUCKET: {
			get: async (key) => (objects.has(key) ? { arrayBuffer: async () => objects.get(key) } : null),
			put: async (key, body) => { objects.set(key, body); },
			delete: async (key) => { objects.delete(key); },
		},
		INBOUND_QUEUE: { send: async (body) => { queue.push(body); }, sendBatch: async (batch) => { for (const message of batch) queue.push(message.body); } },
		REALTIME: { getByName: () => ({ fetch: async () => new Response(null, { status: 204 }) }) },
	};
	const warn = console.warn; console.warn = () => {};
	t.after(() => { console.warn = warn; });
	return { ...database, env, objects, queue };
}
const headersWith = (marker, extra = {}) => ({ from: "Team <team@example.com>", ...PASS, ...(marker ? { "x-mailflare-send-as": marker } : {}), ...extra });
const admit = (f, headers, over = {}, from = "Team <team@example.com>") => app.admitGroupMail(f.env, group(over), { all: headers, from });

test("a marker signs one message and one group and nothing else", async (t) => {
	const f = await fixture(t);
	const marker = await app.signSendAs(f.env, { messageId: "msg_out1", groupId: "g1" });
	assert.match(marker, /^v1\./);
	assert.deepEqual(await app.verifySendAs(f.env, marker, "g1"), { messageId: "msg_out1" });
	assert.equal(await app.verifySendAs(f.env, marker, "g2"), null, "another group");
	assert.equal(await app.verifySendAs(f.env, marker.replace("msg_out1", "msg_out2"), "g1"), null, "another message");
	assert.equal(await app.verifySendAs(f.env, `${marker}0`, "g1"), null, "tampered");
	assert.equal(await app.verifySendAs(f.env, "v1.msg_out1.g1.deadbeef", "g1"), null, "forged");
	assert.equal(await app.verifySendAs(f.env, "1", "g1"), null);
	assert.equal(await app.verifySendAs(f.env, undefined, "g1"), null);
});

test("a members-only group admits its own signed send-as post, and refuses it without a valid marker", async (t) => {
	const f = await fixture(t);
	const marker = await app.signSendAs(f.env, { messageId: "msg_out1", groupId: "g1" });
	assert.equal((await admit(f, headersWith(marker))).action, "group");
	assert.equal((await admit(f, headersWith(null))).action, "reject", "no marker: team@ is nobody's member address");
	assert.equal((await admit(f, headersWith(`${marker}0`))).action, "reject", "tampered marker");
	assert.equal((await admit(f, headersWith(marker), { groupId: "g2", address: "other@example.com" })).action, "reject", "marker of another group");
});

test("the marker needs a trusted DMARC pass and a From that is the group's own address", async (t) => {
	const f = await fixture(t);
	const marker = await app.signSendAs(f.env, { messageId: "msg_out1", groupId: "g1" });
	assert.equal((await admit(f, headersWith(marker, { "authentication-results": "mx.cloudflare.net; dmarc=fail header.from=example.com" }))).action, "reject");
	assert.equal((await admit(f, headersWith(marker, { from: "Mallory <mallory@evil.test>" }), {}, "Mallory <mallory@evil.test>")).action, "reject");
});

const payload = (f, headers) => {
	f.objects.set("inbound/orig.eml", new TextEncoder().encode("From: Team <team@example.com>\r\nTo: team@example.com\r\nSubject: Hi\r\n\r\nhi\r\n").buffer);
	return { from: "team@example.com", to: "team@example.com", rawR2Key: "inbound/orig.eml", headers, groupExpansion: { groupId: "g1" } };
};

test("a signed send-as post gives the sender's own mailbox no copy; the other members still get one", async (t) => {
	const f = await fixture(t);
	const marker = await app.signSendAs(f.env, { messageId: "msg_out1", groupId: "g1" });
	await app.expandGroupDelivery(f.env, payload(f, headersWith(marker)));
	assert.deepEqual(f.queue.map((m) => m.groupDelivery.mailboxId), ["m-bob"]);
});

test("without a valid marker the group's own From gets no self-skip", async (t) => {
	const f = await fixture(t);
	await app.expandGroupDelivery(f.env, payload(f, headersWith(null)));
	assert.deepEqual(f.queue.map((m) => m.groupDelivery.mailboxId).sort(), ["m-alice", "m-bob"]);
});

test("a signed post is admitted once: the same marker is refused the second time", async (t) => {
	const f = await fixture(t);
	const marker = await app.signSendAs(f.env, { messageId: "msg_out1", groupId: "g1" });
	assert.equal((await admit(f, headersWith(marker))).action, "group");
	assert.equal((await admit(f, headersWith(marker))).action, "reject", "replay");
	assert.ok([...f.objects.keys()].some((key) => /^group-relay\/\d+\/sendas\/msg_out1$/.test(key)), "the claim sits under the swept group-relay/<day>/ layout");
});

test("a marker of a message that is unknown or older than the claim records are kept is refused", async (t) => {
	const f = await fixture(t);
	for (const messageId of ["msg_old", "msg_missing"]) {
		const marker = await app.signSendAs(f.env, { messageId, groupId: "g1" });
		assert.equal((await admit(f, headersWith(marker))).action, "reject", messageId);
	}
});

test("the copy skip still works after the post was admitted and its marker used up", async (t) => {
	const f = await fixture(t);
	const marker = await app.signSendAs(f.env, { messageId: "msg_out1", groupId: "g1" });
	assert.equal((await admit(f, headersWith(marker))).action, "group");
	await app.expandGroupDelivery(f.env, payload(f, headersWith(marker)));
	assert.deepEqual(f.queue.map((m) => m.groupDelivery.mailboxId), ["m-bob"]);
});
