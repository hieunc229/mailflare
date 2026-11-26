import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/lib/cloudflare": "export function getEnv(){return globalThis.grp.env}",
	"@/lib/api/auth": "export async function requireSessionUser(){return {user:globalThis.grp.user,error:null}}",
	"@/lib/auth/origin": "export function hasValidSessionMutationOrigin(){return true}",
	"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canManageAccounts:true}}",
	"@/lib/deliverability/report-address": "export async function isReportAddressReserved(){return false}",
	"@/lib/cloudflare-api": "export async function ensureEmailRoutingRuleToWorker(){} export async function deleteEmailRoutingRuleForAddress(){} export async function rollbackEmailRoutingRuleChanges(){}",
};
const { app, newDatabase } = await loadApp("groups-external-members", `
	export * as members from "./src/app/api/groups/[id]/members/route.ts";
	export * as item from "./src/app/api/groups/[id]/route.ts";
	export * as utils from "./src/lib/groups/members-utils.ts";
`, { mocks });

const admin = { id: "admin", role: "admin", isPrimaryAdmin: true, canManageUsers: true, canManageMailboxes: true, createdByUserId: null, email: "admin@example.com" };
const seed = `
	INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, can_manage_users, created_at) VALUES ('admin', 'admin@example.com', 'hash', 'Admin', 'admin', 1, 1, 1);
	INSERT INTO domains (id, user_id, hostname, zone_id, status, receiving_provider, sending_provider, sending_enabled, created_at) VALUES
		('d1', 'admin', 'example.com', 'z1', 'active', 'cloudflare', 'resend', 0, 1),
		('d2', 'admin', 'other.com', 'z2', 'active', 'cloudflare', 'none', 0, 1);
	INSERT INTO mail_groups (id, domain_id, local_part, name, who_can_post, reply_to, disabled, created_at, updated_at) VALUES
		('g1', 'd1', 'team', 'Team', 'anyone', 'sender', 0, 1, 1),
		('g2', 'd2', 'team', 'Team', 'anyone', 'sender', 0, 1, 1);
`;
async function ctx(t) {
	const database = await newDatabase(t, seed);
	globalThis.grp = { env: database.env, user: admin };
	t.after(() => { delete globalThis.grp; });
	return database;
}
const req = (body, method = "POST") => new Request("https://x.test/api/groups", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const ids = (id) => ({ params: Promise.resolve({ id }) });
const add = (members, id = "g1") => app.members.POST(req({ members }), ids(id));

test("an external member is stored lower-cased and trimmed, and a repeat is skipped", async (t) => {
	const { sqlite } = await ctx(t);
	const response = await add([{ kind: "external", email: "  Pat@Ext.COM " }]);
	assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
	const body = await response.json();
	assert.equal(body.added[0].kind, "external");
	assert.equal(body.added[0].email, "pat@ext.com");
	assert.equal(body.added[0].suppressed, false);
	assert.equal(sqlite.prepare("SELECT email, user_id, mailbox_id, can_send_as FROM mail_group_members").get().email, "pat@ext.com");
	const again = await (await add([{ kind: "external", email: "PAT@ext.com" }, { kind: "external", email: "pat@ext.com" }])).json();
	assert.equal(again.added.length, 0);
	assert.deepEqual(again.skipped.map((item) => item.reason), ["already_member", "already_member"]);
	const log = sqlite.prepare("SELECT action, metadata FROM audit_logs ORDER BY rowid").all();
	assert.deepEqual(log.map((row) => row.action), ["group.member_added"]);
	assert.deepEqual(JSON.parse(log[0].metadata), { groupId: "g1", address: "team@example.com", kind: "external", email: "pat@ext.com" });
});

test("an external may be in several groups, and external and internal members mix in one call", async (t) => {
	const { sqlite } = await ctx(t);
	sqlite.exec("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('alice', 'alice@example.com', 'hash', 'Alice', 'user', 1)");
	assert.equal((await add([{ kind: "external", email: "pat@ext.com" }, { kind: "user", userId: "alice" }])).status, 200);
	assert.equal((await add([{ kind: "external", email: "pat@ext.com" }], "g2")).status, 200);
});

test("invalid externals are refused as a whole", async (t) => {
	const { sqlite } = await ctx(t);
	const attempt = async (member, status, pattern) => {
		const response = await add([{ kind: "external", email: "ok@ext.com" }, member]);
		assert.equal(response.status, status, JSON.stringify(member));
		assert.match((await response.json()).error, pattern);
	};
	await attempt({ kind: "external", email: "not-an-address" }, 422, /valid email/i);
	await attempt({ kind: "external", email: "a b@ext.com" }, 422, /valid email/i);
	await attempt({ kind: "external", email: "A <a@ext.com>" }, 422, /valid email/i);
	await attempt({ kind: "external", email: "x@ext.com", canSendAs: true }, 422, /not available yet/i);
	await attempt({ kind: "external", email: "x@Example.com" }, 422, /domain/i);
	await attempt({ kind: "external", email: "x@other.com" }, 422, /domain/i);
	await attempt({ kind: "external", email: "TEAM@example.com" }, 422, /group's own address/i);
	await attempt({ kind: "external" }, 400, /email/i);
	await attempt({ kind: "external", email: "x@ext.com", userId: "alice" }, 400, /email/i);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM mail_group_members").get().n, 0);
});

test("a group holds at most 100 external members", async (t) => {
	const { sqlite } = await ctx(t);
	let sql = "";
	for (let i = 0; i < 99; i += 1) sql += `INSERT INTO mail_group_members (id, group_id, kind, email, can_send_as, created_at) VALUES ('gx${i}', 'g1', 'external', 'x${i}@ext.com', 0, 1);`;
	sqlite.exec(sql);
	assert.equal((await add([{ kind: "external", email: "last@ext.com" }])).status, 200);
	const over = await add([{ kind: "external", email: "over@ext.com" }]);
	assert.equal(over.status, 422);
	assert.match((await over.json()).error, /100 external/);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM mail_group_members WHERE group_id = 'g1'").get().n, 100);
});

test("the group view flags suppressed externals and whether the domain can send", async (t) => {
	const { sqlite } = await ctx(t);
	await add([{ kind: "external", email: "bad@ext.com" }, { kind: "external", email: "good@ext.com" }, { kind: "external", email: "maybe@ext.com" }]);
	sqlite.exec(`INSERT INTO email_suppressions (id, domain_id, email, reason, source, confirmed, first_event_at, last_event_at) VALUES
		('s1', 'd1', 'bad@ext.com', 'hard_bounce', 'resend', 1, 1, 1),
		('s2', 'd1', 'maybe@ext.com', 'hard_bounce', 'dsn', 0, 1, 1),
		('s3', 'd2', 'good@ext.com', 'complaint', 'resend', 1, 1, 1);`);
	const view = await (await app.item.GET(req(undefined, "GET"), ids("g1"))).json();
	assert.deepEqual(Object.fromEntries(view.members.map((m) => [m.email, m.suppressed])), { "bad@ext.com": true, "good@ext.com": false, "maybe@ext.com": false });
});

test("canSend is false only when the domain has no sending provider", async (t) => {
	await ctx(t);
	assert.equal((await (await app.item.GET(req(undefined, "GET"), ids("g1"))).json()).group.canSend, true);
	assert.equal((await (await app.item.GET(req(undefined, "GET"), ids("g2"))).json()).group.canSend, false);
});
