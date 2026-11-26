import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const mocks = {
	"@/lib/cloudflare": "export function getEnv(){return globalThis.unsub.env}",
};
const { app, newDatabase } = await loadApp("groups-unsubscribe", `
	export * as route from "./src/app/api/groups/unsubscribe/[token]/route.ts";
	export { signUnsubscribeToken } from "./src/lib/groups/unsubscribe-token.ts";
`, { mocks });

const SECRET = "server-secret";
const seed = `
	INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('admin', 'admin@example.com', 'hash', 'Admin', 'admin', 1);
	INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d1', 'admin', 'example.com', 'z1', 'active', 1);
	INSERT INTO mail_groups (id, domain_id, local_part, name, who_can_post, reply_to, disabled, created_at, updated_at) VALUES
		('g1', 'd1', 'team', 'Team <b>', 'anyone', 'sender', 0, 1, 1),
		('g2', 'd1', 'sales', 'Sales', 'anyone', 'sender', 0, 1, 1);
	INSERT INTO mail_group_members (id, group_id, kind, email, can_send_as, created_at) VALUES
		('m1', 'g1', 'external', 'pat@ext.com', 0, 1),
		('m2', 'g1', 'external', 'sam@ext.com', 0, 1),
		('m3', 'g2', 'external', 'pat@ext.com', 0, 1);
`;
async function ctx(t, over = {}) {
	const database = await newDatabase(t, seed);
	globalThis.unsub = { env: { ...database.env, CF_TOKEN: SECRET, ...over } };
	t.after(() => { delete globalThis.unsub; });
	return database;
}
const token = (claim = { groupId: "g1", memberId: "m1", email: "pat@ext.com" }, secret = SECRET) => app.signUnsubscribeToken(secret, claim);
const call = (method, t, body, headers) => app.route[method](new Request(`https://mail.example.com/api/groups/unsubscribe/${t}`, { method, body, headers }), { params: Promise.resolve({ token: t }) });
const members = (sqlite) => sqlite.prepare("SELECT id FROM mail_group_members ORDER BY id").all().map((r) => r.id);
const audit = (sqlite) => sqlite.prepare("SELECT action, actor_user_id, metadata FROM audit_logs").all().map((r) => ({ ...r, metadata: JSON.parse(r.metadata) }));

test("GET shows a confirmation page and changes nothing", async (t) => {
	const { sqlite } = await ctx(t);
	const response = await call("GET", await token());
	assert.equal(response.status, 200);
	assert.match(response.headers.get("content-type"), /^text\/html/);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
	assert.match(response.headers.get("x-robots-tag"), /noindex/);
	assert.equal(response.headers.get("referrer-policy"), "no-referrer");
	const html = await response.text();
	assert.match(html, /<form method="post"/);
	assert.match(html, /pat@ext\.com/);
	assert.ok(!html.includes("<b>"), "the group name is escaped");
	assert.match(html, /Team &lt;b&gt;/);
	assert.deepEqual(members(sqlite), ["m1", "m2", "m3"]);
	assert.deepEqual(audit(sqlite), []);
});

test("POST (the confirm button or an RFC 8058 one-click) removes only that member of that group and logs it", async (t) => {
	const { sqlite } = await ctx(t);
	const response = await call("POST", await token(), "List-Unsubscribe=One-Click", { "content-type": "application/x-www-form-urlencoded" });
	assert.equal(response.status, 200);
	assert.deepEqual(members(sqlite), ["m2", "m3"], "the same address in another group stays");
	assert.deepEqual(audit(sqlite), [{ action: "group.member_unsubscribed", actor_user_id: null, metadata: { groupId: "g1", address: "team@example.com", kind: "external", email: "pat@ext.com" } }]);
	// Replaying a link is harmless and writes nothing more.
	assert.equal((await call("POST", await token())).status, 200);
	assert.equal(audit(sqlite).length, 1);
	assert.equal((await call("GET", await token())).status, 200);
});

test("a token that is forged, re-aimed, unsigned or from another secret answers 404 and removes nothing", async (t) => {
	const { sqlite } = await ctx(t);
	const good = await token();
	const [payload] = good.split(".");
	const wrong = [
		await token(undefined, "other-secret"),
		`${Buffer.from("g1\nm2\nsam@ext.com").toString("base64url")}.${good.split(".")[1]}`,
		`${payload}.AAAA`,
		"garbage",
		"",
	];
	for (const bad of wrong) {
		for (const method of ["GET", "POST"]) assert.equal((await call(method, bad)).status, 404, `${method} ${bad}`);
	}
	// Validly signed but not matching a row (wrong group for the member): nothing is deleted.
	const mismatch = await token({ groupId: "g2", memberId: "m1", email: "pat@ext.com" });
	assert.equal((await call("POST", mismatch)).status, 200);
	const wrongEmail = await token({ groupId: "g1", memberId: "m2", email: "pat@ext.com" });
	assert.equal((await call("POST", wrongEmail)).status, 200);
	assert.deepEqual(members(sqlite), ["m1", "m2", "m3"]);
	assert.deepEqual(audit(sqlite), []);
});

test("an unknown member and a removed one look the same, so addresses cannot be enumerated", async (t) => {
	await ctx(t);
	const unknown = await call("POST", await token({ groupId: "g1", memberId: "zz", email: "nobody@ext.com" }));
	const removed = await call("POST", await token());
	const again = await call("POST", await token());
	assert.equal(unknown.status, 200);
	assert.equal(removed.status, 200);
	assert.equal(await unknown.text(), await removed.text());
	assert.equal(again.status, 200);
});

test("without a server secret the route is closed", async (t) => {
	await ctx(t, { CF_TOKEN: undefined });
	assert.equal((await call("GET", await token())).status, 404);
	assert.equal((await call("POST", await token())).status, 404);
});
