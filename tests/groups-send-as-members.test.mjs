import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/lib/cloudflare": "export function getEnv(){return globalThis.grp.env}",
	"@/lib/api/auth": "export async function requireSessionUser(){const u=globalThis.grp.user;if(globalThis.grp.dbDown)throw new Error('database unavailable');return u?{user:u,error:null}:{user:null,error:Response.json({error:'Unauthorized'},{status:401})}}",
	"@/lib/auth/origin": "export function hasValidSessionMutationOrigin(){return globalThis.grp.origin!==false}",
	"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canManageAccounts:globalThis.grp.licensed}}",
	"@/lib/deliverability/report-address": "export async function isReportAddressReserved(env,domainId,localPart){return localPart==='mailflare-reports'}",
	"@/lib/cloudflare-api": `
		export async function ensureEmailRoutingRuleToWorker(env,zone,address,changes){const g=globalThis.grp.cf;if(g.fail)throw new Error('Cloudflare is down');g.ensured.push(address);g.onEnsure?.(address);changes?.push({zoneId:zone,ruleId:'r-'+address})}
		export async function deleteEmailRoutingRuleForAddress(env,zone,address){const g=globalThis.grp.cf;if(g.failDelete)throw new Error('delete failed');g.deleted.push(address);return true}
		export async function rollbackEmailRoutingRuleChanges(env,changes){globalThis.grp.cf.rolledBack.push(...changes.map((c)=>c.ruleId))}
	`,
};

const { app, newDatabase } = await loadApp("groups-send-as-members", `
	export * as list from "./src/app/api/groups/route.ts";
	export * as item from "./src/app/api/groups/[id]/route.ts";
	export * as members from "./src/app/api/groups/[id]/members/route.ts";
	export * as member from "./src/app/api/groups/[id]/members/[memberId]/route.ts";
	export * as candidates from "./src/app/api/groups/[id]/candidates/route.ts";
`, { mocks });

const seed = `
	INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, can_manage_users, created_at) VALUES
		('admin', 'admin@example.com', 'hash', 'Admin', 'admin', 1, 1, 1),
		('alice', 'alice@example.com', 'hash', 'Alice Doe', 'user', 0, 0, 1),
		('bob', 'bob@example.com', 'hash', 'Bob Roe', 'user', 0, 0, 1),
		('off', 'off@example.com', 'hash', 'Off Limits', 'user', 0, 0, 1),
		('other', 'other@elsewhere.com', 'hash', 'Other Admin', 'admin', 0, 1, 1);
	UPDATE users SET disabled = 1 WHERE id = 'off';
	INSERT INTO domains (id, user_id, hostname, zone_id, status, receiving_provider, created_at) VALUES
		('d1', 'admin', 'example.com', 'z1', 'active', 'cloudflare', 1),
		('d2', 'admin', 'other.com', 'z2', 'active', 'resend', 1),
		('dx', 'other', 'elsewhere.com', 'zx', 'active', 'cloudflare', 1);
	INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, use_all_domains, created_at) VALUES
		('m-admin', 'admin', 'd1', 'admin', 'personal', 0, 1),
		('m-alice', 'alice', 'd1', 'alice', 'personal', 0, 1),
		('m-support', 'admin', 'd1', 'support', 'shared', 0, 1),
		('m-ops', 'admin', 'd1', 'ops', 'shared', 0, 1),
		('m-xshared', 'other', 'dx', 'xshared', 'shared', 0, 1),
		('m-john', 'admin', 'd1', 'john', 'personal', 1, 1);
	INSERT INTO mailbox_aliases (id, mailbox_id, domain_id, local_part, enabled, masked, created_at) VALUES
		('a1', 'm-admin', 'd1', 'billing', 1, 0, 1);
`;

const admin = { id: "admin", role: "admin", isPrimaryAdmin: true, canManageUsers: true, canManageMailboxes: true, createdByUserId: null, email: "admin@example.com" };

async function ctx(t, { licensed = true, user = admin } = {}) {
	const database = await newDatabase(t, seed);
	globalThis.grp = { env: database.env, user, licensed, cf: { ensured: [], deleted: [], rolledBack: [] } };
	t.after(() => { delete globalThis.grp; });
	return database;
}

const req = (method, body) => new Request("https://x.test/api/groups", {
	method,
	headers: { "content-type": "application/json" },
	...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const ids = (id, memberId) => ({ params: Promise.resolve({ id, memberId }) });
const audit = (sqlite) => sqlite.prepare("SELECT action, actor_user_id, target_user_id, mailbox_id, metadata FROM audit_logs ORDER BY rowid").all().map((row) => ({ ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null }));
async function makeGroup() {
	const response = await app.list.POST(req("POST", { domainId: "d1", localPart: "team", name: "Team" }));
	assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
	return (await response.json()).group;
}
const flag = (sqlite, userId) => sqlite.prepare("SELECT can_send_as FROM mail_group_members WHERE user_id = ?").get(userId)?.can_send_as;

test("an admin adds a user member who may send as the group, and it is audited", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup();
	const response = await app.members.POST(req("POST", { members: [{ kind: "user", userId: "alice", canSendAs: true }, { kind: "user", userId: "bob" }] }), ids(group.id));
	assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
	const body = await response.json();
	assert.equal(body.added.find((m) => m.userId === "alice").canSendAs, true);
	assert.equal(body.added.find((m) => m.userId === "bob").canSendAs, false);
	assert.equal(flag(sqlite, "alice"), 1);
	assert.equal(flag(sqlite, "bob"), 0);
	const added = audit(sqlite).filter((row) => row.action === "group.member_added");
	assert.deepEqual(added.map((row) => [row.target_user_id, row.metadata.canSendAs]), [["alice", true], ["bob", undefined]]);
});

test("only user members can be allowed to send as the group", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup();
	for (const member of [{ kind: "mailbox", mailboxId: "m-support", canSendAs: true }, { kind: "external", email: "x@ext.com", canSendAs: true }]) {
		const response = await app.members.POST(req("POST", { members: [{ kind: "user", userId: "alice" }, member] }), ids(group.id));
		assert.equal(response.status, 422, JSON.stringify(member));
		assert.match((await response.json()).error, /Only account members/);
	}
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM mail_group_members").get().n, 0);
});

test("toggling send-as on a member takes effect at once and is audited", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup();
	const body = await (await app.members.POST(req("POST", { members: [{ kind: "user", userId: "alice" }, { kind: "mailbox", mailboxId: "m-support" }] }), ids(group.id))).json();
	const user = body.added.find((m) => m.kind === "user");
	const mailbox = body.added.find((m) => m.kind === "mailbox");
	const on = await app.member.PATCH(req("PATCH", { canSendAs: true }), ids(group.id, user.id));
	assert.equal(on.status, 200);
	assert.equal((await on.json()).member.canSendAs, true);
	assert.equal(flag(sqlite, "alice"), 1);
	assert.deepEqual(audit(sqlite).at(-1), { action: "group.member_updated", actor_user_id: "admin", target_user_id: "alice", mailbox_id: null, metadata: { groupId: group.id, address: "team@example.com", kind: "user", canSendAs: true } });
	assert.equal((await app.member.PATCH(req("PATCH", { canSendAs: false }), ids(group.id, user.id))).status, 200);
	assert.equal(flag(sqlite, "alice"), 0);
	assert.equal(audit(sqlite).at(-1).metadata.canSendAs, false);
	const refused = await app.member.PATCH(req("PATCH", { canSendAs: true }), ids(group.id, mailbox.id));
	assert.equal(refused.status, 422);
	assert.match((await refused.json()).error, /Only account members/);
});

test("the group page lists who may send as the group", async (t) => {
	await ctx(t);
	const group = await makeGroup();
	await app.members.POST(req("POST", { members: [{ kind: "user", userId: "alice", canSendAs: true }] }), ids(group.id));
	const detail = await (await app.item.GET(req("GET"), ids(group.id))).json();
	assert.equal(detail.members.find((m) => m.userId === "alice").canSendAs, true);
});

test("setting send-as to the value it already has changes nothing and writes no audit row", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup();
	const body = await (await app.members.POST(req("POST", { members: [{ kind: "user", userId: "alice", canSendAs: true }] }), ids(group.id))).json();
	const member = body.added[0];
	const before = audit(sqlite).length;
	for (const value of [true, true]) {
		const response = await app.member.PATCH(req("PATCH", { canSendAs: value }), ids(group.id, member.id));
		assert.equal(response.status, 200);
		assert.equal((await response.json()).member.canSendAs, true);
	}
	assert.equal(audit(sqlite).length, before);
	await app.member.PATCH(req("PATCH", { canSendAs: false }), ids(group.id, member.id));
	assert.equal(audit(sqlite).length, before + 1);
});

test("a group name with control characters is refused on create and update", async (t) => {
	await ctx(t);
	for (const name of ["Team\r\nBcc: x@evil.test", "Te\u0007am", "Te\u007fam"]) {
		const created = await app.list.POST(req("POST", { domainId: "d1", localPart: "ctl", name }));
		assert.equal(created.status, 400, JSON.stringify(name));
	}
	const group = await makeGroup();
	const updated = await app.item.PATCH(req("PATCH", { name: "Bad\nname" }), ids(group.id));
	assert.equal(updated.status, 400);
});

test("each user member says whether they have a primary mailbox for send-as to show up in", async (t) => {
	await ctx(t);
	const group = await makeGroup();
	await app.members.POST(req("POST", { members: [{ kind: "user", userId: "alice" }, { kind: "user", userId: "bob" }, { kind: "mailbox", mailboxId: "m-support" }] }), ids(group.id));
	const { members } = await (await app.item.GET(req("GET"), ids(group.id))).json();
	assert.deepEqual(Object.fromEntries(members.map((m) => [m.name, m.hasPrimaryMailbox])), { "Alice Doe": true, "Bob Roe": false, support: true });
});
