import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app } = await loadApp("groups-relay-utils", `
	export * as relay from "./src/lib/groups/relay-utils.ts";
	export * as token from "./src/lib/groups/unsubscribe-token.ts";
	export * as secret from "./src/lib/groups/unsubscribe-secret.ts";
`);
const { relay, token, secret: secretKey } = app;

test("the relay copy key is deterministic per group and message and lives under its day", async () => {
	const at = new Date("2026-12-01T10:00:00Z");
	const day = Math.floor(at / 86400000);
	const a = await relay.relayStorageKey("g1", "abc", at);
	assert.equal(a, await relay.relayStorageKey("g1", "abc", at));
	assert.notEqual(a, await relay.relayStorageKey("g2", "abc", at));
	assert.notEqual(a, await relay.relayStorageKey("g1", "abd", at));
	assert.match(a, new RegExp(`^group-relay/${day}/copy/[0-9a-f]{64}\\.eml$`));
	assert.ok(a.startsWith(relay.GROUP_RELAY_PREFIX));
	assert.match(await relay.relayChunkKey("g1", "abc", undefined, at), new RegExp(`^group-relay/${day}/chunk/[0-9a-f]{64}$`));
	assert.match(await relay.relayMessageIdKey("<x@y>", at), new RegExp(`^group-relay/${day}/mid/`));
	assert.equal((await relay.relayMessageIdKeys("<x@y>", at)).length, relay.RELAY_MID_LOOKUP_DAYS);
	assert.match(relay.relaySkipKey("g1", "abc", at), new RegExp(`^group-relay/${day}/skip/`));
});

test("non-ASCII names become RFC 2047 words where a header travels as written, and stay UTF-8 for providers that encode", () => {
	const input = { senderName: "José Ñandú", senderAddress: "jose@gmail.com", groupName: "Équipe", groupAddress: "team@a.com" };
	assert.equal(relay.relayFrom(input), `"'José Ñandú <jose@gmail.com>' via Équipe" <team@a.com>`);
	const encoded = relay.relayFrom(input, true);
	assert.ok(/^[\x20-\x7e]+$/.test(encoded), encoded);
	const words = [...encoded.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g)].map((m) => m[1]);
	assert.equal(Buffer.concat(words.map((w) => Buffer.from(w, "base64"))).toString("utf8"), "'José Ñandú <jose@gmail.com>' via Équipe");
	assert.match(encoded, / <team@a\.com>$/);
	assert.ok(!encoded.includes('"'), "encoded words are never inside quotes");
	assert.equal(relay.relayFromName(input), "'José Ñandú <jose@gmail.com>' via Équipe");
	const headers = relay.relayHeaders({ groupId: "g", groupName: "Équipe", localPart: "team", hostname: "a.com", replyTo: "sender", senderAddress: "jose@gmail.com", originalFrom: relay.relayOriginalFrom("José", "jose@gmail.com"), unsubscribeUrl: null, inReplyTo: null, references: [] });
	assert.ok(/^[\x20-\x7e]+$/.test(headers["List-Id"]) && /^[\x20-\x7e]+$/.test(headers["X-Original-From"]));
	assert.match(headers["List-Id"], /^=\?UTF-8\?B\?.+\?= <team\.a\.com>$/);
	assert.match(headers["X-Original-From"], /^=\?UTF-8\?B\?.+\?= <jose@gmail\.com>$/);
	assert.equal(relay.relayOriginalFrom("Bob Roe", "bob@gmail.com"), '"Bob Roe" <bob@gmail.com>');
	assert.equal(relay.relayOriginalFrom(null, "bob@gmail.com"), "bob@gmail.com");
});

test("encoded words stay under 75 characters and never cut a character in half", () => {
	const text = "日本語のとても長い名前".repeat(8) + "😀".repeat(20);
	const encoded = relay.encodeWords(text);
	const words = encoded.split(" ");
	assert.ok(words.length > 3);
	for (const word of words) assert.ok(word.length <= 75, word.length);
	const decoded = Buffer.concat(words.map((w) => Buffer.from(/=\?UTF-8\?B\?(.+)\?=/.exec(w)[1], "base64"))).toString("utf8");
	assert.equal(decoded, text);
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

test("the unsubscribe secret adopts whatever is stored once racing creators have settled", async () => {
	const objects = new Map();
	const bucket = {
		get: async (key) => (objects.has(key) ? { arrayBuffer: async () => objects.get(key) } : null),
		// A second isolate's write lands right after ours and wins.
		put: async (key, body) => { objects.set(key, body); objects.set(key, new TextEncoder().encode("b".repeat(64)).buffer); },
	};
	secretKey.forgetUnsubscribeSecretCache();
	assert.equal(await secretKey.getUnsubscribeSecret({ BUCKET: bucket }), "b".repeat(64));
});
