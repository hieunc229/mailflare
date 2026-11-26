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
const { app, newDatabase } = await loadApp("groups-relay-outside", `
	export { expandGroupDelivery } from "./src/lib/groups/expand.ts";
	export { processGroupRelay } from "./src/lib/groups/relay.ts";
	export * as relayUtils from "./src/lib/groups/relay-utils.ts";
	export * as policy from "./src/lib/groups/policy-utils.ts";
	export { resolveIncomingMail } from "./src/lib/email/incoming.ts";
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



test("externalsMayReceive: only an anyone group asks, and the toggle or a qualified poster answers", () => {
	const may = app.policy.externalsMayReceive;
	assert.equal(may({ whoCanPost: "anyone", relayOutsidePosts: false, qualified: false }), false);
	assert.equal(may({ whoCanPost: "anyone", relayOutsidePosts: true, qualified: false }), true);
	assert.equal(may({ whoCanPost: "anyone", relayOutsidePosts: false, qualified: true }), true);
	assert.equal(may({ whoCanPost: "org", relayOutsidePosts: false, qualified: false }), true, "admission already required a qualified poster");
	assert.equal(may({ whoCanPost: "members", relayOutsidePosts: false, qualified: false }), true);
});

const post = (from, extra = {}) => ({ from, headers: { from }, ...extra });
const names = (queue) => queue.map((m) => m.body.memberId).sort();

test("an outsider's post to an anyone group reaches internal members only, unless the group's toggle is on", async (t) => {
	const { env, outbound, inbound, payload, sqlite } = await fixture(t);
	await app.expandGroupDelivery(env, payload());
	assert.equal(outbound.length, 0, "bob@gmail.com is neither a member nor from our domains");
	assert.equal(inbound.length, 1, "internal members are unaffected");
	sqlite.exec("UPDATE mail_groups SET relay_outside_posts = 1");
	await app.expandGroupDelivery(env, payload());
	assert.deepEqual(names(outbound), ["gm2", "gm3"]);
});

test("a member or someone from your own domain is qualified without the toggle", async (t) => {
	for (const from of ["alice@example.com", "ceo@example.com"]) {
		const { env, outbound, payload } = await fixture(t);
		await app.expandGroupDelivery(env, payload(post(from)));
		assert.deepEqual(names(outbound), ["gm2", "gm3"], from);
	}
	const { env, outbound, payload } = await fixture(t);
	await app.expandGroupDelivery(env, payload(post("pat@ext.com")));
	assert.deepEqual(names(outbound), ["gm3"], "an external member qualifies; they are not sent their own post");
	const lookalike = await fixture(t);
	await app.expandGroupDelivery(lookalike.env, lookalike.payload(post("ceo@example.com.evil.test")));
	assert.equal(lookalike.outbound.length, 0);
});

test("a qualified poster still needs the trusted DMARC pass, and org and members groups are unaffected", async (t) => {
	const { env, outbound, payload, sqlite } = await fixture(t);
	await app.expandGroupDelivery(env, payload(post("alice@example.com", { verdicts: undefined })));
	assert.equal(outbound.length, 0);
	sqlite.exec("UPDATE mail_groups SET who_can_post = 'members'");
	await app.expandGroupDelivery(env, payload(post("bob@gmail.com")));
	assert.equal(outbound.length, 2, "admission already decided; no second check");
});

test("before the migration the toggle reads as off and mail still flows", async (t) => {
	const { env, outbound, inbound, payload, sqlite } = await fixture(t);
	sqlite.exec("ALTER TABLE mail_groups DROP COLUMN relay_outside_posts");
	await app.expandGroupDelivery(env, payload());
	assert.equal(outbound.length, 0);
	assert.equal(inbound.length, 1);
	await app.expandGroupDelivery(env, payload(post("alice@example.com")));
	assert.equal(outbound.length, 2);
	const decision = await app.resolveIncomingMail(env, "bob@gmail.com", "team@example.com", { all: {} });
	assert.equal(decision.action, "group");
});
