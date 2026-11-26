import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app } = await loadApp("groups-relay-utils", `
	export * as relay from "./src/lib/groups/relay-utils.ts";
	export * as token from "./src/lib/groups/unsubscribe-token.ts";
	export * as secret from "./src/lib/groups/unsubscribe-secret.ts";
`);
const { relay, token, secret: secretKey } = app;

test("the relay copy key is deterministic per group and message and lives under group-relay/", async () => {
	const a = await relay.relayStorageKey("g1", "abc");
	assert.equal(a, await relay.relayStorageKey("g1", "abc"));
	assert.notEqual(a, await relay.relayStorageKey("g2", "abc"));
	assert.notEqual(a, await relay.relayStorageKey("g1", "abd"));
	assert.match(a, /^group-relay\/[0-9a-f]{64}\.eml$/);
	assert.ok(a.startsWith(relay.GROUP_RELAY_PREFIX));
});

test("relay queue messages are recognised only when complete", () => {
	const ok = { kind: "group.relay", groupId: "g", memberId: "m", rawR2Key: "group-relay/x.eml" };
	assert.equal(relay.isGroupRelayMessage(ok), true);
	for (const bad of [null, "x", {}, { ...ok, kind: "email.scheduled" }, { ...ok, memberId: 1 }, { ...ok, rawR2Key: undefined }]) assert.equal(relay.isGroupRelayMessage(bad), false);
	assert.equal(relay.relayIdempotencyKey(ok), "g:group-relay/x.eml:m");
});

test("From shows the sender through the group address and cannot be header-injected", () => {
	assert.equal(relay.relayFrom({ senderName: "Bob", senderAddress: "bob@gmail.com", groupName: "Team", groupAddress: "team@a.com" }), `"'Bob <bob@gmail.com>' via Team" <team@a.com>`);
	assert.equal(relay.relayFrom({ senderName: "", senderAddress: "bob@gmail.com", groupName: "Team", groupAddress: "team@a.com" }), `"'bob@gmail.com' via Team" <team@a.com>`);
	assert.equal(relay.relayFrom({ senderName: 'Jane "JJ" \\ Doe', senderAddress: "j@x.com", groupName: "T", groupAddress: "t@a.com" }), `"'Jane \\"JJ\\" \\\\ Doe <j@x.com>' via T" <t@a.com>`);
	// A name that looks like another address cannot hide the real one: the real address always follows it.
	assert.match(relay.relayFrom({ senderName: "ceo@bank.com", senderAddress: "evil@x.com", groupName: "T", groupAddress: "t@a.com" }), /ceo@bank\.com <evil@x\.com>' via T/);
	const evil = relay.relayFrom({ senderName: "Eve\r\nBcc: x@y.z", senderAddress: "e@e.com", groupName: 'T"\neam', groupAddress: "team@a.com" });
	assert.ok(!/[\r\n]/.test(evil));
	assert.match(evil, /<team@a\.com>$/);
});

const base = { groupId: "g1", groupName: "Team", localPart: "team", hostname: "a.com", replyTo: "sender", senderAddress: "bob@gmail.com", originalFrom: "Bob <bob@gmail.com>", unsubscribeUrl: "https://m.test/api/groups/unsubscribe/T", inReplyTo: "<p@x>", references: ["<r1@x>", "<p@x>"] };

test("relayed copies carry the list headers, the group marker and the keyed forwarded marker", () => {
	const h = relay.relayHeaders(base);
	assert.equal(h["Reply-To"], "bob@gmail.com");
	assert.equal(h["List-Id"], `"Team" <team.a.com>`);
	assert.equal(h["List-Post"], "<mailto:team@a.com>");
	assert.equal(h["List-Unsubscribe"], "<https://m.test/api/groups/unsubscribe/T>");
	assert.equal(h["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
	assert.equal(h.Precedence, "list");
	assert.equal(h["X-Mailflare-Group"], "g1");
	assert.equal("X-Mailflare-Forwarded" in h, false, "the installation-wide marker never goes to outsiders");
	assert.equal(h["X-Original-From"], "Bob <bob@gmail.com>");
	assert.equal(h["In-Reply-To"], "<p@x>");
	assert.equal(h.References, "<r1@x> <p@x>");
});

test("reply-to group points at the group; no unsubscribe URL means no unsubscribe headers", () => {
	const h = relay.relayHeaders({ ...base, replyTo: "group", unsubscribeUrl: null, inReplyTo: null, references: [] });
	assert.equal(h["Reply-To"], "team@a.com");
	assert.equal("List-Unsubscribe" in h, false);
	assert.equal("List-Unsubscribe-Post" in h, false);
	assert.equal("In-Reply-To" in h, false);
	assert.equal("References" in h, false);
});

const secret = "s3cret";
const claim = { groupId: "grp_1", memberId: "gmb_1" };

test("unsubscribe tokens verify, and any change to them is refused", async () => {
	const t = await token.signUnsubscribeToken(secret, claim);
	assert.match(t, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
	assert.deepEqual(await token.verifyUnsubscribeToken(secret, t), claim);
	assert.equal(await token.verifyUnsubscribeToken("other", t), null);
	const [payload, mac] = t.split(".");
	assert.equal(await token.verifyUnsubscribeToken(secret, `${payload}.${mac.slice(0, -2)}AA`), null);
	const forged = Buffer.from("grp_1\ngmb_2").toString("base64url");
	assert.equal(await token.verifyUnsubscribeToken(secret, `${forged}.${mac}`), null);
	for (const junk of ["", ".", "a.b.c", "!!.??", `${payload}.`, `.${mac}`]) assert.equal(await token.verifyUnsubscribeToken(secret, junk), null);
	assert.notEqual(await token.signUnsubscribeToken(secret, { ...claim, groupId: "grp_2" }), t);
	assert.ok(!Buffer.from(t.split(".")[0], "base64url").toString().includes("@"), "the token carries no email address");
});

test("the unsubscribe secret is generated once, kept in the bucket and survives a restart", async () => {
	const objects = new Map();
	const bucket = {
		get: async (key) => (objects.has(key) ? { arrayBuffer: async () => objects.get(key) } : null),
		put: async (key, body) => { objects.set(key, typeof body === "string" ? new TextEncoder().encode(body).buffer : body); },
	};
	const first = await secretKey.getUnsubscribeSecret({ BUCKET: bucket });
	assert.match(first, /^[0-9a-f]{64}$/);
	assert.equal(await secretKey.getUnsubscribeSecret({ BUCKET: bucket }), first);
	secretKey.forgetUnsubscribeSecretCache();
	assert.equal(await secretKey.getUnsubscribeSecret({ BUCKET: { ...bucket } }), first, "a new isolate reads the stored one");
	assert.equal(objects.size, 1);
});
