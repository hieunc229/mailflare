import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const mocks = {
	"@/lib/spam/engine": `export async function analyzeSpam() { globalThis.relayLog.analysed = (globalThis.relayLog.analysed ?? 0) + 1; return { score: 0, verdict: globalThis.relayLog.verdict ?? "inbox", signals: [], fingerprint: "f" }; }`,
	"@/lib/email/outbound-provider": `
		export async function getOutboundProviderConfig(env, from) { globalThis.relayLog.configs.push(from); return { provider: "resend", apiKey: "k" }; }
		export async function sendThroughProvider(env, config, message, key) { if (globalThis.relayLog.error) throw globalThis.relayLog.error; if (globalThis.relayLog.fail) throw new Error("provider down"); globalThis.relayLog.sent.push({ message, key }); return { messageId: "<provider-" + globalThis.relayLog.sent.length + "@mta.test>" }; }
	`,
};
const { app, newDatabase } = await loadApp("groups-relay-caps", `
	export { expandGroupDelivery } from "./src/lib/groups/expand.ts";
	export { processGroupRelay } from "./src/lib/groups/relay.ts";
	export * as relayUtils from "./src/lib/groups/relay-utils.ts";
	export { verifyUnsubscribeToken } from "./src/lib/groups/unsubscribe-token.ts";
`, { mocks });

const seed = (provider = "resend") => `
	INSERT INTO users (id, email, password_hash, name, role, disabled, created_at) VALUES
		('admin', 'admin@example.com', 'hash', 'Admin', 'admin', 0, 1),
		('alice', 'alice@example.com', 'hash', 'Alice', 'user', 0, 1);
	INSERT INTO domains (id, user_id, hostname, zone_id, status, sending_provider, sending_enabled, created_at) VALUES ('d1', 'admin', 'example.com', 'z1', 'active', '${provider}', 1, 1);
	INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('m-alice', 'alice', 'd1', 'alice', 'personal', 1);
	INSERT INTO mail_groups (id, domain_id, local_part, name, who_can_post, reply_to, disabled, created_at, updated_at) VALUES ('g1', 'd1', 'team', 'Team', 'anyone', 'sender', 0, 1, 1);
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


const hourNow = () => Math.floor(Date.now() / 3_600_000);
const dayNow = () => Math.floor(Date.now() / 86_400_000);
const rateKey = (group, n, sends = 1, flag = "ok", hour = hourNow()) => `group-relay/rate/${Math.floor(hour / 24)}/${hour}/${group}/${String(n).padStart(64, "0")}-${sends}-${flag}`;
const audits = (sqlite) => sqlite.prepare("SELECT action, actor_user_id, metadata FROM audit_logs WHERE action = 'group.relay_capped'").all().map((r) => ({ ...r, metadata: JSON.parse(r.metadata) }));

test("pure: rate keys round-trip and the allowance trips on the first scope that is full", () => {
	const u = app.relayUtils;
	const key = u.relayRateKey({ groupId: "g1", digest: "ab".repeat(32), sends: 3, flag: "ok", now: new Date("2026-12-01T10:30:00Z") });
	assert.deepEqual(u.parseRateKey(key), { day: Math.floor(Date.parse("2026-12-01T10:30:00Z") / 86400000), hour: Math.floor(Date.parse("2026-12-01T10:30:00Z") / 3600000), groupId: "g1", digest: "ab".repeat(32), sends: 3, flag: "ok" });
	assert.equal(u.parseRateKey("group-relay/rate/x"), null);
	const entry = (groupId, sends, hour = 10, day = 0) => ({ day, hour, groupId, sends, digest: "d", flag: "ok" });
	assert.deepEqual(u.planRelayAllowance([], { groupId: "g", hour: 10, day: 0, sends: 5 }), { ok: true });
	const hourFull = [entry("g", u.GROUP_SENDS_PER_HOUR - 4)];
	assert.deepEqual(u.planRelayAllowance(hourFull, { groupId: "g", hour: 10, day: 0, sends: 5 }), { ok: false, scope: "group", period: "hour", limit: u.GROUP_SENDS_PER_HOUR });
	assert.equal(u.planRelayAllowance(hourFull, { groupId: "g", hour: 10, day: 0, sends: 4 }).ok, true);
	assert.equal(u.planRelayAllowance(hourFull, { groupId: "g", hour: 11, day: 0, sends: 5 }).ok, true, "another hour is a fresh hourly allowance");
	const dayFull = [entry("g", u.GROUP_SENDS_PER_DAY - 1, 3)];
	assert.deepEqual(u.planRelayAllowance(dayFull, { groupId: "g", hour: 10, day: 0, sends: 2 }), { ok: false, scope: "group", period: "day", limit: u.GROUP_SENDS_PER_DAY });
	assert.equal(u.planRelayAllowance(dayFull, { groupId: "other", hour: 10, day: 0, sends: 2 }).ok, true, "per group");
	const others = Array.from({ length: 20 }, (_, i) => entry(`o${i}`, u.INSTALL_SENDS_PER_HOUR / 20));
	assert.deepEqual(u.planRelayAllowance(others, { groupId: "g", hour: 10, day: 0, sends: 1 }), { ok: false, scope: "installation", period: "hour", limit: u.INSTALL_SENDS_PER_HOUR });
	const days = Array.from({ length: 20 }, (_, i) => entry(`o${i}`, u.INSTALL_SENDS_PER_DAY / 20, i));
	assert.deepEqual(u.planRelayAllowance(days, { groupId: "g", hour: 30, day: 0, sends: 1 }), { ok: false, scope: "installation", period: "day", limit: u.INSTALL_SENDS_PER_DAY });
	assert.ok(u.GROUP_SENDS_PER_DAY <= 500 && u.INSTALL_SENDS_PER_DAY <= 2000, "low defaults");
});

test("a message counts messages x external members against the group's hour", async (t) => {
	const { env, outbound, inbound, payload, objects } = await fixture(t);
	objects.set(rateKey("g1", 1, app.relayUtils.GROUP_SENDS_PER_HOUR - 1), new ArrayBuffer(0));
	await app.expandGroupDelivery(env, payload());
	assert.equal(outbound.length, 0, "2 externals would be 2 sends over the allowance");
	assert.equal(inbound.length, 1, "internal members are unaffected");
});

test("the group's day, and the whole installation's hour and day, are capped too", async (t) => {
	const u = app.relayUtils;
	for (const [name, fill] of [
		["group day", (objects) => objects.set(rateKey("g1", 1, u.GROUP_SENDS_PER_DAY - 1, "ok", hourNow() - 1 < dayNow() * 24 ? hourNow() : hourNow() - 1), new ArrayBuffer(0))],
		["installation hour", (objects) => { for (let i = 0; i < 40; i += 1) objects.set(rateKey(`o${i}`, i, u.INSTALL_SENDS_PER_HOUR / 40), new ArrayBuffer(0)); }],
		["installation day", (objects) => { for (let i = 0; i < 40; i += 1) objects.set(rateKey(`o${i}`, i, u.INSTALL_SENDS_PER_DAY / 40, "ok", dayNow() * 24), new ArrayBuffer(0)); }],
	]) {
		const { env, outbound, objects, payload } = await fixture(t);
		fill(objects);
		await app.expandGroupDelivery(env, payload());
		assert.equal(outbound.length, 0, name);
	}
});

test("a message under the caps is counted once, however many chunks it takes", async (t) => {
	const { env, outbound, objects, payload, sqlite } = await fixture(t);
	let sql = "";
	for (let i = 0; i < 30; i += 1) sql += `INSERT INTO mail_group_members (id, group_id, kind, email, can_send_as, created_at) VALUES ('gz${String(i).padStart(2, "0")}', 'g1', 'external', 'z${i}@ext.com', 0, 1);`;
	sqlite.exec(sql);
	const queue = [payload()];
	const send = env.INBOUND_QUEUE.send;
	env.INBOUND_QUEUE.send = async (body) => { if (body.groupExpansion) queue.push(body); else await send(body); };
	while (queue.length) await app.expandGroupDelivery(env, queue.shift());
	assert.equal(outbound.length, 32);
	const markers = [...objects.keys()].filter((key) => key.startsWith("group-relay/rate/"));
	assert.equal(markers.length, 1);
	assert.match(markers[0], /-32-ok$/);
	assert.equal(globalThis.relayLog.analysed, 1, "spam analysis ran once per message, not per chunk");
	const delays = outbound.map((m) => m.options.delaySeconds).sort((a, b) => a - b);
	assert.equal(delays.at(-1), 15, "spread by position among all 32 externals, not restarted per chunk");
});

test("mail the spam filters put aside is not relayed, and the verdict is remembered", async (t) => {
	const { env, outbound, inbound, objects, payload } = await fixture(t);
	for (const verdict of ["spam", "suspicious"]) {
		globalThis.relayLog.verdict = verdict;
		objects.clear();
		await app.expandGroupDelivery(env, payload());
		assert.equal(outbound.length, 0, verdict);
		assert.match([...objects.keys()].find((key) => key.startsWith("group-relay/rate/")), /-0-skip$/);
	}
	assert.equal(inbound.length, 2, "internal members still get it, each mailbox's own filter decides");
	globalThis.relayLog.verdict = "inbox";
	objects.clear();
	await app.expandGroupDelivery(env, payload());
	assert.equal(outbound.length, 2);
});

test("when a cap trips the admin is told once per period, in the audit log", async (t) => {
	const { env, objects, payload, sqlite } = await fixture(t);
	objects.set(rateKey("g1", 1, app.relayUtils.GROUP_SENDS_PER_HOUR), new ArrayBuffer(0));
	await app.expandGroupDelivery(env, payload());
	await app.expandGroupDelivery(env, payload());
	const [entry, ...rest] = audits(sqlite);
	assert.equal(rest.length, 0);
	assert.equal(entry.actor_user_id, null);
	assert.deepEqual(entry.metadata, { groupId: "g1", address: "team@example.com", scope: "group", period: "hour", limit: app.relayUtils.GROUP_SENDS_PER_HOUR });
});

test("the chunk marker is written before the relays are queued, so a failure cannot double-bill", async (t) => {
	const { env, objects, outbound, payload } = await fixture(t);
	const sendBatch = env.OUTBOUND_QUEUE.sendBatch;
	let markersSeen = -1;
	env.OUTBOUND_QUEUE.sendBatch = async (batch) => { markersSeen = [...objects.keys()].filter((key) => key.startsWith("group-relay/chunk/")).length; throw new Error("queue down"); };
	await assert.rejects(() => app.expandGroupDelivery(env, payload()), /queue down/);
	assert.equal(markersSeen, 1);
	env.OUTBOUND_QUEUE.sendBatch = sendBatch;
	await app.expandGroupDelivery(env, payload());
	assert.equal(outbound.length, 0, "the redelivered chunk does not queue them (at most once, logged)");
});

test("mail with several From addresses is never relayed", async (t) => {
	const { env, outbound, inbound, payload } = await fixture(t);
	await app.expandGroupDelivery(env, payload({ headers: { from: "a@x.com, b@y.com" } }));
	assert.equal(outbound.length, 0);
	assert.equal(inbound.length, 1);
});
