import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const mocks = {
	"@/lib/email/outbound-provider": `
		export async function getOutboundProviderConfig(env, from) { globalThis.relayLog.configs.push(from); return globalThis.relayLog.provider === "cloudflare" ? { provider: "cloudflare" } : globalThis.relayLog.provider === "ses" ? { provider: "ses", config: {} } : { provider: "resend", apiKey: "k" }; }
		export async function sendThroughProvider(env, config, message, key) { if (globalThis.relayLog.error) throw globalThis.relayLog.error; if (globalThis.relayLog.fail) throw new Error("provider down"); globalThis.relayLog.sent.push({ message, key }); return { messageId: "<provider-" + globalThis.relayLog.sent.length + "@mta.test>" }; }
	`,
};
const { app, newDatabase } = await loadApp("groups-relay", `
	export { expandGroupDelivery } from "./src/lib/groups/expand.ts";
	export { processGroupRelay } from "./src/lib/groups/relay.ts";
	export * as relayUtils from "./src/lib/groups/relay-utils.ts";
	export { verifyUnsubscribeToken } from "./src/lib/groups/unsubscribe-token.ts";
	export { sweepOrphanedRawMail } from "./src/lib/email/raw-sweeper.ts";
`, { mocks });

const seed = (provider = "resend") => `
	INSERT INTO users (id, email, password_hash, name, role, disabled, created_at) VALUES
		('admin', 'admin@example.com', 'hash', 'Admin', 'admin', 0, 1),
		('alice', 'alice@example.com', 'hash', 'Alice', 'user', 0, 1);
	INSERT INTO domains (id, user_id, hostname, zone_id, status, sending_provider, sending_enabled, created_at) VALUES ('d1', 'admin', 'example.com', 'z1', 'active', '${provider}', 1, 1);
	INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('m-alice', 'alice', 'd1', 'alice', 'personal', 1);
	INSERT INTO mail_groups (id, domain_id, local_part, name, who_can_post, reply_to, relay_outside_posts, disabled, created_at, updated_at) VALUES ('g1', 'd1', 'team', 'Team', 'anyone', 'sender', 1, 0, 1, 1);
	INSERT INTO mail_group_members (id, group_id, kind, user_id, email, can_send_as, created_at) VALUES
		('gm1', 'g1', 'user', 'alice', NULL, 0, 1),
		('gm2', 'g1', 'external', NULL, 'pat@ext.com', 0, 1),
		('gm3', 'g1', 'external', NULL, 'sam@ext.com', 0, 1);
	INSERT INTO license_settings (id, instance_id, plan, state, updated_at) VALUES ('default', 'inst', 'team', 'active', 1);
`;
const MIME = (from = "Bob Roe <bob@gmail.com>") => `From: ${from}\r\nTo: team@example.com\r\nSubject: Hello team\r\nMessage-ID: <abc@x.test>\r\nIn-Reply-To: <prev@x.test>\r\nReferences: <root@x.test> <prev@x.test>\r\nDate: Thu, 26 Nov 2026 10:00:00 +0000\r\nContent-Type: text/plain\r\n\r\nhi there\r\n`;

async function fixture(t, provider) {
	const database = await newDatabase(t, seed(provider));
	const objects = new Map();
	const inbound = [];
	const outbound = [];
	const bucket = {
		get: async (key) => (objects.has(key) ? { arrayBuffer: async () => objects.get(key) } : null),
		put: async (key, body) => { objects.set(key, body); },
		delete: async (key) => { for (const k of [key].flat()) objects.delete(k); },
		list: async ({ prefix, limit = 1000 }) => ({ objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).slice(0, limit).map((key) => ({ key, uploaded: new Date() })), truncated: false }),
	};
	const env = {
		...database.env,
		MAILFLARE_RUNTIME: "node",
		APP_URL: "https://mail.example.com",
		CF_TOKEN: "server-secret",
		BUCKET: bucket,
		INBOUND_QUEUE: { send: async (b) => { inbound.push(b); }, sendBatch: async (batch) => { for (const m of batch) inbound.push(m.body); } },
		OUTBOUND_QUEUE: { send: async (b, o) => { outbound.push({ body: b, options: o }); }, sendBatch: async (batch) => { env.outboundBatches.push(batch.length); for (const m of batch) outbound.push({ body: m.body, options: { delaySeconds: m.delaySeconds } }); } },
		outboundBatches: [],
	};
	globalThis.relayLog = { configs: [], sent: [] };
	t.after(() => { delete globalThis.relayLog; });
	const warn = console.warn; console.warn = () => {};
	t.after(() => { console.warn = warn; });
	const payload = (over = {}) => {
		objects.set("inbound/orig.eml", new TextEncoder().encode(MIME()).buffer);
		return { from: "bob@gmail.com", to: "team@example.com", rawR2Key: "inbound/orig.eml", headers: { from: "Bob Roe <bob@gmail.com>" }, verdicts: { dmarc: "PASS" }, groupExpansion: { groupId: "g1" }, ...over };
	};
	return { ...database, env, objects, inbound, outbound, payload };
}

test("expansion queues one relay message per external member, sharing one relay copy", async (t) => {
	const { env, objects, outbound, inbound, payload } = await fixture(t);
	await app.expandGroupDelivery(env, payload());
	assert.equal(inbound.length, 1, "alice still gets her internal copy");
	assert.deepEqual(outbound.map((m) => m.body.memberId).sort(), ["gm2", "gm3"]);
	assert.deepEqual(env.outboundBatches, [2]);
	const keys = new Set(outbound.map((m) => m.body.rawR2Key));
	assert.equal(keys.size, 1);
	const [key] = keys;
	
	assert.equal(new TextDecoder().decode(objects.get(key)), MIME());
	assert.match(key, /^group-relay\/\d+\/copy\/[0-9a-f]{64}\.eml$/);
	assert.ok(outbound.every((m) => m.body.kind === "group.relay" && m.body.groupId === "g1"));
	assert.equal(objects.has("inbound/orig.eml"), false);
	// A redelivered chunk (its queue message failed after the relays were queued) must not queue them twice:
	// SES and Cloudflare sending have no idempotency key, so a second queueing would be a second billed send.
	const queued = outbound.length;
	await app.expandGroupDelivery(env, payload());
	assert.equal(outbound.length, queued);
});

test("only a trusted DMARC pass is relayed; others reach internal members only", async (t) => {
	const { env, outbound, inbound, payload } = await fixture(t);
	await app.expandGroupDelivery(env, payload({ verdicts: undefined }));
	await app.expandGroupDelivery(env, payload({ verdicts: { dmarc: "FAIL" } }));
	assert.equal(outbound.length, 0);
	assert.equal(inbound.length, 2);
});

test("a message the receiver flags as spam or a virus is not relayed", async (t) => {
	const { env, outbound, inbound, payload } = await fixture(t);
	await app.expandGroupDelivery(env, payload({ verdicts: { dmarc: "PASS", spam: "FAIL" } }));
	await app.expandGroupDelivery(env, payload({ verdicts: { dmarc: "PASS", virus: "FAIL" } }));
	assert.equal(outbound.length, 0);
	assert.equal(inbound.length, 2);
	await app.expandGroupDelivery(env, payload({ verdicts: { dmarc: "PASS", spam: "PASS" } }));
	assert.equal(outbound.length, 2);
});

test("relays are spread out so a provider's rate limit is not hit by 100 at once", async (t) => {
	const { env, outbound, payload, sqlite } = await fixture(t);
	let sql = "";
	for (let i = 0; i < 5; i += 1) sql += `INSERT INTO mail_group_members (id, group_id, kind, email, can_send_as, created_at) VALUES ('gy${i}', 'g1', 'external', 'y${i}@ext.com', 0, 1);`;
	sqlite.exec(sql);
	await app.expandGroupDelivery(env, payload());
	const delays = outbound.map((m) => m.options.delaySeconds).sort((a, b) => a - b);
	assert.equal(delays.length, 7);
	assert.equal(delays[0], 0);
	assert.ok(delays.at(-1) >= 3, `last relay waits ${delays.at(-1)}s`);
	assert.ok(delays.every((d) => d <= 20));
});

test("a domain that cannot send relays nothing, and a poster does not get their own post back", async (t) => {
	const none = await fixture(t, "none");
	await app.expandGroupDelivery(none.env, none.payload());
	assert.equal(none.outbound.length, 0);
	assert.equal(none.inbound.length, 1);
	const { env, outbound, payload, sqlite } = await fixture(t);
	sqlite.exec("UPDATE domains SET sending_provider = 'cloudflare', sending_enabled = 0");
	await app.expandGroupDelivery(env, payload());
	assert.equal(outbound.length, 0, "Cloudflare sending not switched on");
	sqlite.exec("UPDATE domains SET sending_provider = 'resend'");
	await app.expandGroupDelivery(env, payload({ from: "pat@ext.com", headers: { from: "Pat <pat@ext.com>" } }));
	assert.deepEqual(outbound.map((m) => m.body.memberId), ["gm3"]);
});

test("relay messages stay within one chunk's subrequest allowance", async (t) => {
	const { env, outbound, payload, sqlite } = await fixture(t);
	let sql = "";
	for (let i = 0; i < 60; i += 1) sql += `INSERT INTO mail_group_members (id, group_id, kind, email, can_send_as, created_at) VALUES ('gx${String(i).padStart(2, "0")}', 'g1', 'external', 'x${i}@ext.com', 0, 1);`;
	sqlite.exec(sql);
	const queue = [payload()];
	let chunks = 0;
	const origSend = env.INBOUND_QUEUE.send;
	env.INBOUND_QUEUE.send = async (body) => { if (body.groupExpansion) queue.push(body); else await origSend(body); };
	while (queue.length) { chunks += 1; await app.expandGroupDelivery(env, queue.shift()); }
	assert.equal(outbound.length, 62);
	assert.ok(chunks >= 4);
	assert.ok(env.outboundBatches.every((n) => n <= app.relayUtils.GROUP_RELAY_BATCH_MAX && n <= 20));
});

const relayMessage = (over = {}) => ({ kind: "group.relay", groupId: "g1", memberId: "gm2", rawR2Key: "group-relay/x.eml", ...over });
async function relayFixture(t, provider) {
	const f = await fixture(t, provider);
	f.objects.set("group-relay/x.eml", new TextEncoder().encode(MIME()).buffer);
	return f;
}

test("a relay sends the sender's mail from the group address to that one member", async (t) => {
	const { env } = await relayFixture(t);
	assert.equal(await app.processGroupRelay(env, relayMessage()), "sent");
	const [{ message, key }] = globalThis.relayLog.sent;
	assert.equal(key, "g1:group-relay/x.eml:gm2");
	assert.equal(message.from, `"'Bob Roe <bob@gmail.com>' via Team" <team@example.com>`);
	assert.equal(message.headers["X-Original-From"], '"Bob Roe" <bob@gmail.com>');
	assert.deepEqual(message.to, ["pat@ext.com"]);
	assert.equal(message.subject, "Hello team");
	assert.match(message.text, /hi there/);
	assert.equal(message.headers["Reply-To"], "bob@gmail.com");
	assert.equal(message.headers["List-Id"], `"Team" <team.example.com>`);
	assert.equal(message.headers["List-Post"], "<mailto:team@example.com>");
	assert.equal(message.headers.Precedence, "list");
	assert.equal(message.headers["X-Mailflare-Group"], "g1");
	assert.equal("X-Mailflare-Forwarded" in message.headers, false);
	assert.equal(message.headers["In-Reply-To"], "<prev@x.test>");
	assert.equal(message.headers.References, "<root@x.test> <prev@x.test> <abc@x.test>", "the original's Message-ID is kept so replies thread");
	assert.equal(message.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
	assert.deepEqual(globalThis.relayLog.configs, ["team@example.com"]);
});

test("the unsubscribe link is signed for exactly this group and member", async (t) => {
	const { env, objects } = await relayFixture(t);
	await app.processGroupRelay(env, relayMessage());
	const url = globalThis.relayLog.sent[0].message.headers["List-Unsubscribe"];
	const match = /^<https:\/\/mail\.example\.com\/api\/groups\/unsubscribe\/([^>]+)>$/.exec(url);
	assert.ok(match, url);
	const stored = new TextDecoder().decode(objects.get("secrets/group-unsubscribe.key"));
	assert.deepEqual(await app.verifyUnsubscribeToken(stored, match[1]), { groupId: "g1", memberId: "gm2" });
	assert.equal(await app.verifyUnsubscribeToken("server-secret", match[1]), null, "not keyed from CF_TOKEN");
});

test("without APP_URL the copy has no unsubscribe headers, and reply-to group is honoured", async (t) => {
	const { env, sqlite } = await relayFixture(t);
	sqlite.exec("UPDATE mail_groups SET reply_to = 'group'");
	for (const strip of [{ APP_URL: undefined }, { APP_URL: "http://insecure.test" }]) {
		globalThis.relayLog.sent.length = 0;
		await app.processGroupRelay({ ...env, ...strip }, relayMessage());
		const { headers } = globalThis.relayLog.sent[0].message;
		assert.equal("List-Unsubscribe" in headers, false);
		assert.equal("List-Unsubscribe-Post" in headers, false);
		assert.equal(headers["Reply-To"], "team@example.com");
	}
});

test("suppression: skipped in enforce mode, sent in record and off modes, unconfirmed entries never skip", async (t) => {
	const { env, sqlite } = await relayFixture(t);
	sqlite.exec(`INSERT INTO email_suppressions (id, domain_id, email, reason, source, confirmed, first_event_at, last_event_at) VALUES ('s1', 'd1', 'pat@ext.com', 'hard_bounce', 'resend', 1, 1, 1), ('s2', 'd1', 'sam@ext.com', 'hard_bounce', 'dsn', 0, 1, 1)`);
	sqlite.exec("UPDATE app_settings SET suppression_mode = 'enforce' WHERE id = 'default'");
	assert.equal(await app.processGroupRelay(env, relayMessage()), "skipped");
	assert.equal(await app.processGroupRelay(env, relayMessage({ memberId: "gm3" })), "sent");
	for (const mode of ["record", "off"]) {
		sqlite.exec(`UPDATE app_settings SET suppression_mode = '${mode}' WHERE id = 'default'`);
		assert.equal(await app.processGroupRelay(env, relayMessage()), "sent", mode);
	}
});

test("a relay for a removed member, a paused group, a lapsed licence, a domain that cannot send or a swept copy is dropped without sending", async (t) => {
	const { env, sqlite, objects } = await relayFixture(t);
	assert.equal(await app.processGroupRelay(env, relayMessage({ memberId: "gm1" })), "skipped", "not an external member");
	assert.equal(await app.processGroupRelay(env, relayMessage({ memberId: "nope" })), "skipped");
	assert.equal(await app.processGroupRelay(env, relayMessage({ groupId: "nope" })), "skipped");
	sqlite.exec("UPDATE mail_groups SET disabled = 1");
	assert.equal(await app.processGroupRelay(env, relayMessage()), "skipped");
	sqlite.exec("UPDATE mail_groups SET disabled = 0; UPDATE license_settings SET plan = 'community'");
	assert.equal(await app.processGroupRelay(env, relayMessage()), "skipped");
	sqlite.exec("UPDATE license_settings SET plan = 'team'; UPDATE domains SET sending_provider = 'none'");
	assert.equal(await app.processGroupRelay(env, relayMessage()), "skipped");
	sqlite.exec("UPDATE domains SET sending_provider = 'resend'");
	const quiet = console.error; console.error = () => {};
	t.after(() => { console.error = quiet; });
	objects.delete("group-relay/x.eml");
	assert.equal(await app.processGroupRelay(env, relayMessage()), "skipped");
	assert.equal(globalThis.relayLog.sent.length, 0);
});

test("a provider failure throws so the queue retries the one member", async (t) => {
	const { env } = await relayFixture(t);
	globalThis.relayLog.fail = true;
	await assert.rejects(() => app.processGroupRelay(env, relayMessage()), /provider down/);
});

test("the relay budget lets the first message of a batch through and defers the rest", () => {
	const budget = app.relayUtils.createRelayBudget();
	let ran = 0;
	while (app.relayUtils.reserveRelay(budget)) ran += 1;
	assert.ok(ran >= 1 && ran <= 4, `${ran} relays per batch`);
	assert.equal(app.relayUtils.reserveRelay(app.relayUtils.createRelayBudget()), true);
});

const day = () => Math.floor(Date.now() / 86_400_000);

test("the daily sweep deletes whole expired days of every kind, and keeps the rest, whatever the volume", async (t) => {
	const { env, objects } = await fixture(t);
	const now = new Date("2026-12-20T00:30:00Z");
	const today = Math.floor(now / 86_400_000);
	const kinds = ["copy", "mid", "rate", "chunk", "skip", "capnote"];
	for (const kind of kinds) {
		for (const d of [today, today - 3, today - 6, today - 7, today - 8]) objects.set(`group-relay/${d}/${kind}/keep-or-not.x`, new ArrayBuffer(1));
	}
	// One old day holds far more than a page, and today holds more than the sweep ever reads.
	for (let i = 0; i < 2500; i += 1) objects.set(`group-relay/${today - 7}/mid/m${i}`, new ArrayBuffer(1));
	for (let i = 0; i < 7000; i += 1) objects.set(`group-relay/${today}/mid/t${i}`, new ArrayBuffer(1));
	env.BUCKET.list = async ({ prefix, limit = 1000 }) => {
		const keys = [...objects.keys()].filter((key) => key.startsWith(prefix));
		return { objects: keys.slice(0, limit).map((key) => ({ key, uploaded: now })), truncated: keys.length > limit };
	};
	env.BUCKET.delete = async (keys) => { for (const key of [keys].flat()) objects.delete(key); };
	await app.sweepOrphanedRawMail(env, now);
	const left = [...objects.keys()];
	assert.ok(!left.some((key) => key.startsWith(`group-relay/${today - 7}/`) || key.startsWith(`group-relay/${today - 8}/`)), "days at the TTL are gone, all kinds, all 2500+");
	for (const d of [today, today - 3, today - 6]) for (const kind of kinds) assert.ok(left.includes(`group-relay/${d}/${kind}/keep-or-not.x`), `${d} ${kind}`);
	assert.equal(left.filter((key) => key.startsWith(`group-relay/${today}/mid/t`)).length, 7000);
});

test("a missed sweep is made up for on the next run", async (t) => {
	const { env, objects } = await fixture(t);
	const now = new Date("2026-12-20T00:30:00Z");
	const today = Math.floor(now / 86_400_000);
	objects.set(`group-relay/${today - 9}/copy/old.eml`, new ArrayBuffer(1));
	objects.set(`group-relay/${today - 12}/copy/ancient.eml`, new ArrayBuffer(1));
	env.BUCKET.list = async ({ prefix }) => ({ objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, uploaded: now })), truncated: false });
	env.BUCKET.delete = async (keys) => { for (const key of [keys].flat()) objects.delete(key); };
	await app.sweepOrphanedRawMail(env, now);
	assert.ok(!objects.has(`group-relay/${today - 9}/copy/old.eml`), "two days late is still found");
});

test("a post too big for the provider is not sent, and the admin is told once per message", async (t) => {
	const { env, objects, sqlite } = await relayFixture(t);
	const big = Buffer.alloc(6 * 1024 * 1024, 1).toString("base64").replace(/(.{76})/g, "$1\r\n");
	const mime = `From: Bob <bob@gmail.com>\r\nTo: team@example.com\r\nSubject: Big\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nsee file\r\n--b\r\nContent-Type: application/pdf; name="f.pdf"\r\nContent-Disposition: attachment; filename="f.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${big}\r\n--b--\r\n`;
	objects.set("group-relay/x.eml", new TextEncoder().encode(mime).buffer);
	globalThis.relayLog.provider = "cloudflare";
	assert.equal(await app.processGroupRelay(env, relayMessage()), "skipped");
	assert.equal(await app.processGroupRelay(env, relayMessage({ memberId: "gm3" })), "skipped");
	assert.equal(globalThis.relayLog.sent.length, 0);
	const rows = sqlite.prepare("SELECT metadata FROM audit_logs WHERE action = 'group.relay_skipped'").all().map((r) => JSON.parse(r.metadata));
	assert.equal(rows.length, 1);
	assert.equal(rows[0].reason, "message_too_large");
	globalThis.relayLog.provider = "resend";
	assert.equal(await app.processGroupRelay(env, relayMessage()), "sent", "the same message goes through a provider that carries it");
});

test("each provider gets the sender in the form it handles: UTF-8, RFC 2047 words, or name and address apart", async (t) => {
	const { env, objects } = await relayFixture(t);
	objects.set("group-relay/x.eml", new TextEncoder().encode(MIME("=?utf-8?B?Sm9zw6k=?= <jose@gmail.com>")).buffer);
	const sendOnce = async (provider) => {
		globalThis.relayLog.provider = provider;
		globalThis.relayLog.sent.length = 0;
		await app.processGroupRelay(env, relayMessage());
		return globalThis.relayLog.sent[0].message;
	};
	const resend = await sendOnce("resend");
	assert.equal(resend.from, `"'José <jose@gmail.com>' via Team" <team@example.com>`);
	const ses = await sendOnce("ses");
	assert.ok(/^[\x20-\x7e]+$/.test(ses.from) && ses.from.includes("=?UTF-8?B?"), ses.from);
	const cloudflare = await sendOnce("cloudflare");
	assert.deepEqual(cloudflare.fromParts, { name: "'José <jose@gmail.com>' via Team", email: "team@example.com" });
	assert.match(cloudflare.headers["X-Original-From"], /^=\?UTF-8\?B\?.+\?= <jose@gmail\.com>$/);
});
