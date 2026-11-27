import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("groups-relay-bounces", `
	export { resolveIncomingMail } from "./src/lib/email/incoming.ts";
	export { relayMessageIdKey } from "./src/lib/groups/relay-utils.ts";
	export * as relayUtils from "./src/lib/groups/relay-utils.ts";
`);

const seed = `
	INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('admin', 'admin@example.com', 'hash', 'Admin', 'admin', 1);
	INSERT INTO domains (id, user_id, hostname, zone_id, status, sending_provider, created_at) VALUES ('d1', 'admin', 'example.com', 'z1', 'active', 'cloudflare', 1);
	INSERT INTO mail_groups (id, domain_id, local_part, name, who_can_post, reply_to, disabled, created_at, updated_at) VALUES
		('g1', 'd1', 'team', 'Team', 'anyone', 'group', 0, 1, 1),
		('g2', 'd1', 'sales', 'Sales', 'anyone', 'group', 0, 1, 1);
	INSERT INTO mail_group_members (id, group_id, kind, email, can_send_as, created_at) VALUES
		('m1', 'g1', 'external', 'pat@ext.com', 0, 1),
		('m2', 'g1', 'external', 'sam@ext.com', 0, 1),
		('m3', 'g2', 'external', 'pat@ext.com', 0, 1);
	INSERT INTO license_settings (id, instance_id, plan, state, updated_at) VALUES ('default', 'inst', 'team', 'active', 1);
`;
const DSN = ({ rcpt = "pat@ext.com", id = "<cf-1@mta.test>", status = "5.1.1", action = "failed" } = {}) => [
	"From: MAILER-DAEMON@mta.test", "To: team@example.com", "Subject: Undelivered", 'Content-Type: multipart/report; report-type=delivery-status; boundary="b"', "", "--b", "Content-Type: text/plain", "", "failed", "--b",
	"Content-Type: message/delivery-status", "", "Reporting-MTA: dns; mta.test", "", `Final-Recipient: rfc822; ${rcpt}`, `Action: ${action}`, `Status: ${status}`, "Diagnostic-Code: smtp; 550 no such user", "", "--b",
	"Content-Type: message/rfc822", "", `Message-ID: ${id}`, 'From: "\'Bob\' via Team" <team@example.com>', "Subject: x", "", "--b--", "",
].join("\r\n");
const dsnHeaders = { "content-type": 'multipart/report; report-type=delivery-status; boundary="b"', "return-path": "<>" };

async function fixture(t, mode = "record") {
	const database = await newDatabase(t, seed);
	database.sqlite.exec(`UPDATE app_settings SET suppression_mode = '${mode}' WHERE id = 'default'`);
	const objects = new Map();
	const env = { ...database.env, BUCKET: { get: async (key) => (objects.has(key) ? { arrayBuffer: async () => objects.get(key) } : null), put: async (key, body) => { objects.set(key, body); } } };
	const remember = async (messageId, g, m) => objects.set(await app.relayMessageIdKey(messageId), new TextEncoder().encode(JSON.stringify({ g, m })));
	await remember("<cf-1@mta.test>", "g1", "m1");
	const warn = console.warn; console.warn = () => {};
	t.after(() => { console.warn = warn; });
	const suppressed = () => database.sqlite.prepare("SELECT domain_id, email, reason, source, confirmed FROM email_suppressions").all();
	const dsn = (raw, headers = dsnHeaders) => app.resolveIncomingMail(env, "", "team@example.com", { all: headers, loadRaw: async () => new TextEncoder().encode(raw).buffer });
	return { ...database, env, objects, remember, suppressed, dsn };
}

test("a bounce naming a relayed copy's Message-ID and its own member suppresses that address, then is dropped", async (t) => {
	const { dsn, suppressed } = await fixture(t);
	assert.deepEqual(await dsn(DSN()), { action: "drop" });
	assert.deepEqual(suppressed(), [{ domain_id: "d1", email: "pat@ext.com", reason: "hard_bounce", source: "dsn", confirmed: 0 }], "one bounce proves nothing: Message-IDs are visible to members");
});

test("the same copy's ID in another spelling is still one copy, so it never confirms on its own", async (t) => {
	const { dsn, suppressed } = await fixture(t);
	await dsn(DSN());
	await dsn(DSN());
	await dsn(DSN({ id: "<CF-1@MTA.test>" }));
	await dsn(DSN({ id: "  cf-1@mta.test " }));
	assert.equal(suppressed().length, 1);
	assert.equal(suppressed()[0].confirmed, 0);
});

test("a second bounce naming a different copy confirms it, as with every other DSN", async (t) => {
	const { dsn, suppressed, remember } = await fixture(t);
	await dsn(DSN());
	await remember("<cf-3@mta.test>", "g1", "m1");
	await dsn(DSN({ id: "<cf-3@mta.test>" }));
	assert.equal(suppressed()[0].confirmed, 1);
});

test("a copy's Message-ID is found for the whole week it is kept, and not on the day after", async (t) => {
	const { dsn, suppressed, objects, sqlite } = await fixture(t);
	const day = (n) => new Date(Date.now() - n * 86_400_000);
	assert.equal(app.relayUtils.RELAY_MID_LOOKUP_DAYS, app.relayUtils.GROUP_RELAY_TTL_DAYS);
	for (const [n, found] of [[0, true], [6, true], [7, false]]) {
		objects.clear();
		sqlite.exec("DELETE FROM email_suppressions");
		objects.set(await app.relayMessageIdKey("<cf-1@mta.test>", day(n)), new TextEncoder().encode(JSON.stringify({ g: "g1", m: "m1" })));
		await dsn(DSN());
		assert.equal(suppressed().length > 0, found, `${n} days old`);
	}
});

test("the days of a Message-ID are looked up together, not one after another", async (t) => {
	const { env, dsn } = await fixture(t);
	let inFlight = 0;
	let widest = 0;
	const get = env.BUCKET.get;
	env.BUCKET.get = async (key) => {
		inFlight += 1;
		widest = Math.max(widest, inFlight);
		await new Promise((resolve) => setTimeout(resolve, 2));
		inFlight -= 1;
		return get(key);
	};
	await dsn(DSN({ id: "<unknown@mta.test>" }));
	assert.ok(widest >= app.relayUtils.RELAY_MID_LOOKUP_DAYS, `${widest} lookups at once`);
});

test("a bounce that does not fit is dropped and records nothing", async (t) => {
	const { dsn, suppressed, remember } = await fixture(t);
	assert.deepEqual(await dsn(DSN({ rcpt: "sam@ext.com" })), { action: "drop" }, "names another member than the copy was for");
	assert.deepEqual(await dsn(DSN({ id: "<unknown@mta.test>" })), { action: "drop" }, "a Message-ID we never relayed");
	await remember("<cf-2@mta.test>", "g2", "m3");
	assert.deepEqual(await dsn(DSN({ id: "<cf-2@mta.test>" })), { action: "drop" }, "a copy of another group's");
	assert.deepEqual(await dsn(DSN({ status: "4.2.2" })), { action: "drop" }, "a temporary failure");
	assert.deepEqual(await dsn(DSN({ action: "delayed" })), { action: "drop" });
	assert.deepEqual(await dsn("not a report"), { action: "drop" });
	assert.deepEqual(suppressed(), []);
});

test("suppression off records nothing; a removed member is not suppressed", async (t) => {
	const off = await fixture(t, "off");
	await off.dsn(DSN());
	assert.deepEqual(off.suppressed(), []);
	const gone = await fixture(t);
	gone.sqlite.exec("DELETE FROM mail_group_members WHERE id = 'm1'");
	await gone.dsn(DSN());
	assert.deepEqual(gone.suppressed(), []);
});

test("without the raw message a bounce is simply dropped", async (t) => {
	const { env, suppressed } = await fixture(t);
	assert.deepEqual(await app.resolveIncomingMail(env, "", "team@example.com", { all: dsnHeaders }), { action: "drop" });
	assert.deepEqual(suppressed(), []);
});

const auto = { "auto-submitted": "auto-generated", from: "noreply@helpdesk.example.org" };

test("automated mail answering a relayed copy is dropped whoever sends it; the same mail unrelated is delivered", async (t) => {
	const { env, remember } = await fixture(t);
	const to = (headers, address = "team@example.com") => app.resolveIncomingMail(env, "bounce@helpdesk.example.org", address, { all: headers, from: headers.from });
	assert.deepEqual(await to({ ...auto, "in-reply-to": "<cf-1@mta.test>" }), { action: "drop" });
	assert.deepEqual(await to({ ...auto, references: "<root@x> <cf-1@MTA.test>" }), { action: "drop" });
	assert.equal((await to({ ...auto, "in-reply-to": "<other@x>" })).action, "group");
	assert.equal((await to(auto)).action, "group");
	assert.equal((await to({ from: "pat@ext.com", "in-reply-to": "<cf-1@mta.test>" })).action, "group", "a human reply is not automated");
	await remember("<cf-9@mta.test>", "g2", "m3");
	assert.equal((await to({ ...auto, "in-reply-to": "<cf-9@mta.test>" })).action, "group", "a copy of another group's");
	assert.deepEqual(await to({ ...auto, "in-reply-to": "<cf-9@mta.test>" }, "sales@example.com"), { action: "drop" });
});
