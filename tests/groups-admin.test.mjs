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

const { app, newDatabase } = await loadApp("groups-admin", `
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
const create = (body) => app.list.POST(req("POST", { domainId: "d1", localPart: "team", name: "Team", ...body }));
const audit = (sqlite) => sqlite.prepare("SELECT action, actor_user_id, target_user_id, mailbox_id, metadata FROM audit_logs ORDER BY rowid").all().map((row) => ({ ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null }));
async function makeGroup(extra = {}) {
	const response = await create(extra);
	assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
	return (await response.json()).group;
}

test("every route needs the accounts licence and a user manager", async (t) => {
	await ctx(t, { licensed: false });
	for (const response of [await app.list.GET(req("GET")), await create({})]) {
		assert.equal(response.status, 403);
		assert.equal((await response.json()).code, "LICENSE_REQUIRED");
	}
	globalThis.grp.licensed = true;
	globalThis.grp.user = { ...admin, role: "user", isPrimaryAdmin: false };
	assert.equal((await app.list.GET(req("GET"))).status, 403);
	globalThis.grp.user = { ...admin, isPrimaryAdmin: false, canManageUsers: false };
	assert.equal((await create({})).status, 403);
	globalThis.grp.user = null;
	assert.equal((await app.list.GET(req("GET"))).status, 401, "an expired session is a 401, not a 403");
});

test("a database failure while authenticating is not reported as a permission error", async (t) => {
	await ctx(t);
	globalThis.grp.dbDown = true;
	await assert.rejects(() => app.list.GET(req("GET")), /database unavailable/);
});

test("a cross-site mutation is refused", async (t) => {
	await ctx(t);
	globalThis.grp.origin = false;
	assert.equal((await create({})).status, 403);
});

test("create stores the group, routes the address and writes an audit entry", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup({ localPart: "Team", description: "Everyone" });
	assert.equal(group.address, "team@example.com");
	assert.equal(group.whoCanPost, "anyone");
	assert.equal(group.replyTo, "sender");
	assert.equal(group.memberCount, 0);
	const row = sqlite.prepare("SELECT * FROM mail_groups WHERE id = ?").get(group.id);
	assert.equal(row.local_part, "team");
	assert.equal(row.created_by_user_id, "admin");
	assert.deepEqual(globalThis.grp.cf.ensured, ["team@example.com"]);
	assert.deepEqual(audit(sqlite), [{ action: "group.created", actor_user_id: "admin", target_user_id: null, mailbox_id: null, metadata: { groupId: group.id, address: "team@example.com" } }]);
});

test("create skips the Cloudflare rule when Cloudflare does not receive the domain", async (t) => {
	await ctx(t);
	await makeGroup({ domainId: "d2" });
	assert.deepEqual(globalThis.grp.cf.ensured, []);
});

test("create validates the body and the domain", async (t) => {
	await ctx(t);
	const bad = await create({ localPart: "bad address" });
	assert.equal(bad.status, 400);
	assert.match((await bad.json()).error, /letters, numbers/i, "the reason is readable text");
	assert.equal((await create({ name: "" })).status, 400);
	assert.match((await (await create({ name: "" })).json()).error, /name/i);
	assert.equal((await create({ whoCanPost: "moderated" })).status, 400);
	assert.equal((await create({ domainId: "dx" })).status, 404);
	assert.equal((await create({ domainId: "nope" })).status, 404);
});

test("create answers 409 for every owner of the address, normalized", async (t) => {
	await ctx(t);
	const clash = async (localPart, expected, domainId = "d1") => {
		const response = await create({ localPart, domainId });
		assert.equal(response.status, 409, localPart);
		assert.match((await response.json()).error, expected);
	};
	await clash("support", /mailbox already uses/i);
	await clash("s.upport+x", /mailbox already uses/i);
	await clash("billing", /alias already uses/i);
	await clash("mailflare-reports", /reserved/i);
	await clash("john", /mailbox already uses/i, "d2");
	await makeGroup({ localPart: "team" });
	await clash("t.eam", /group already uses/i);
	assert.deepEqual(globalThis.grp.cf.ensured, ["team@example.com"]);
});

test("a failed Cloudflare rule rolls the group back", async (t) => {
	const { sqlite } = await ctx(t);
	globalThis.grp.cf.fail = true;
	const response = await create({});
	assert.equal(response.status, 502);
	assert.match((await response.json()).error, /Cloudflare is down/);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM mail_groups").get().n, 0);
	assert.deepEqual(audit(sqlite), []);
});

test("a domain holds at most 50 groups", async (t) => {
	const { sqlite } = await ctx(t);
	for (let i = 0; i < 50; i += 1) sqlite.exec(`INSERT INTO mail_groups (id, domain_id, local_part, name, created_at, updated_at) VALUES ('g${i}', 'd1', 'g${i}', 'G', 1, 1)`);
	const response = await create({});
	assert.equal(response.status, 422);
	assert.match((await response.json()).error, /50 groups/);
	assert.equal((await create({ domainId: "d2" })).status, 201);
});

test("create and list report 503 until the migration is applied", async (t) => {
	const { sqlite } = await ctx(t);
	sqlite.exec("DROP TABLE mail_group_members; DROP TABLE mail_groups");
	for (const response of [await app.list.GET(req("GET")), await create({})]) {
		assert.equal(response.status, 503);
		assert.equal((await response.json()).code, "MIGRATION_REQUIRED");
	}
});

test("list shows member counts for the domains the admin may use", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup({});
	sqlite.exec(`INSERT INTO mail_groups (id, domain_id, local_part, name, created_at, updated_at) VALUES ('gx', 'dx', 'secret', 'Hidden', 1, 1)`);
	await app.members.POST(req("POST", { members: [{ kind: "user", userId: "alice" }, { kind: "mailbox", mailboxId: "m-support" }] }), ids(group.id));
	const body = await (await app.list.GET(req("GET"))).json();
	assert.deepEqual(body.groups.map((g) => [g.address, g.memberCount]), [["team@example.com", 2]]);
	assert.deepEqual(body.domains.map((d) => d.hostname).sort(), ["example.com", "other.com"]);
});

test("get returns members with their display details, and hides other admins' groups", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup({});
	await app.members.POST(req("POST", { members: [{ kind: "user", userId: "alice" }, { kind: "mailbox", mailboxId: "m-support" }] }), ids(group.id));
	const body = await (await app.item.GET(req("GET"), ids(group.id))).json();
	assert.equal(body.group.address, "team@example.com");
	const byKind = Object.fromEntries(body.members.map((m) => [m.kind, m]));
	assert.deepEqual([byKind.user.name, byKind.user.address], ["Alice Doe", "alice@example.com"]);
	assert.deepEqual([byKind.mailbox.name, byKind.mailbox.address], ["support", "support@example.com"]);
	sqlite.exec(`INSERT INTO mail_groups (id, domain_id, local_part, name, created_at, updated_at) VALUES ('gx', 'dx', 'secret', 'Hidden', 1, 1)`);
	assert.equal((await app.item.GET(req("GET"), ids("gx"))).status, 404);
	assert.equal((await app.item.GET(req("GET"), ids("missing"))).status, 404);
});

test("update changes settings and audits only the changed keys", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup({});
	const response = await app.item.PATCH(req("PATCH", { name: "Crew", whoCanPost: "members", replyTo: "group", disabled: true, description: "x" }), ids(group.id));
	assert.equal(response.status, 200);
	const row = sqlite.prepare("SELECT * FROM mail_groups WHERE id = ?").get(group.id);
	assert.deepEqual([row.name, row.who_can_post, row.reply_to, row.disabled, row.description], ["Crew", "members", "group", 1, "x"]);
	assert.deepEqual(audit(sqlite).at(-1).metadata, { groupId: group.id, address: "team@example.com", changed: ["name", "description", "whoCanPost", "replyTo", "disabled"] });
	await app.item.PATCH(req("PATCH", { name: "Crew" }), ids(group.id));
	assert.equal(audit(sqlite).length, 2, "an unchanged save is not audited");
	assert.equal((await app.item.PATCH(req("PATCH", { whoCanPost: "nobody" }), ids(group.id))).status, 400);
});

test("changing the address moves the routing rule and checks for conflicts", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup({});
	globalThis.grp.cf.ensured.length = 0;
	assert.equal((await app.item.PATCH(req("PATCH", { localPart: "support" }), ids(group.id))).status, 409);
	assert.equal((await app.item.PATCH(req("PATCH", { localPart: "t.eam" }), ids(group.id))).status, 200, "its own address, normalized, is not a conflict");
	const moved = await app.item.PATCH(req("PATCH", { localPart: "crew", domainId: "d2" }), ids(group.id));
	assert.equal(moved.status, 200);
	assert.equal((await moved.json()).group.address, "crew@other.com");
	assert.deepEqual(globalThis.grp.cf.deleted, ["team@example.com", "t.eam@example.com"]);
	assert.deepEqual(audit(sqlite).at(-1).metadata, { groupId: group.id, address: "crew@other.com", previousAddress: "t.eam@example.com", changed: ["localPart", "domainId"] });
	assert.deepEqual(globalThis.grp.cf.ensured, ["t.eam@example.com"], "resend-received d2 needs no rule");
	assert.equal(sqlite.prepare("SELECT domain_id FROM mail_groups WHERE id = ?").get(group.id).domain_id, "d2");
});

test("a failed rule for a new address leaves the group where it was", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup({});
	globalThis.grp.cf.fail = true;
	const response = await app.item.PATCH(req("PATCH", { localPart: "crew" }), ids(group.id));
	assert.equal(response.status, 502);
	assert.equal(sqlite.prepare("SELECT local_part FROM mail_groups WHERE id = ?").get(group.id).local_part, "team");
	assert.deepEqual(globalThis.grp.cf.deleted, []);
});

test("delete removes the group, its members and its routing rule", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup({});
	await app.members.POST(req("POST", { members: [{ kind: "user", userId: "alice" }] }), ids(group.id));
	const response = await app.item.DELETE(req("DELETE"), ids(group.id));
	assert.equal(response.status, 200);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM mail_groups").get().n, 0);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM mail_group_members").get().n, 0);
	assert.deepEqual(globalThis.grp.cf.deleted, ["team@example.com"]);
	assert.deepEqual(audit(sqlite).at(-1), { action: "group.deleted", actor_user_id: "admin", target_user_id: null, mailbox_id: null, metadata: { groupId: group.id, address: "team@example.com" } });
	assert.equal((await app.item.DELETE(req("DELETE"), ids(group.id))).status, 404);
});

test("delete still succeeds when the Cloudflare rule cannot be removed", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup({});
	globalThis.grp.cf.failDelete = true;
	const response = await app.item.DELETE(req("DELETE"), ids(group.id));
	assert.equal(response.status, 200);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM mail_groups").get().n, 0);
});

test("adding members stores users and shared mailboxes and audits each", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup({});
	const response = await app.members.POST(req("POST", { members: [{ kind: "user", userId: "alice" }, { kind: "mailbox", mailboxId: "m-support" }, { kind: "user", userId: "bob" }] }), ids(group.id));
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.equal(body.added.length, 3);
	assert.deepEqual(body.skipped, []);
	const rows = sqlite.prepare("SELECT kind, user_id, mailbox_id, email, can_send_as, created_by_user_id FROM mail_group_members ORDER BY kind, user_id").all();
	assert.deepEqual(rows, [
		{ kind: "mailbox", user_id: null, mailbox_id: "m-support", email: null, can_send_as: 0, created_by_user_id: "admin" },
		{ kind: "user", user_id: "alice", mailbox_id: null, email: null, can_send_as: 0, created_by_user_id: "admin" },
		{ kind: "user", user_id: "bob", mailbox_id: null, email: null, can_send_as: 0, created_by_user_id: "admin" },
	]);
	const added = audit(sqlite).filter((entry) => entry.action === "group.member_added");
	assert.equal(added.length, 3);
	assert.deepEqual(added.map((entry) => [entry.target_user_id, entry.mailbox_id, entry.metadata.kind]).sort(), [[null, "m-support", "mailbox"], ["alice", null, "user"], ["bob", null, "user"]]);
	assert.equal(added[0].metadata.address, "team@example.com");
});

test("a single member body works and a member already in the group is skipped", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup({});
	assert.equal((await app.members.POST(req("POST", { kind: "user", userId: "alice" }), ids(group.id))).status, 200);
	const again = await (await app.members.POST(req("POST", { members: [{ kind: "user", userId: "alice" }, { kind: "user", userId: "alice" }, { kind: "user", userId: "bob" }] }), ids(group.id))).json();
	assert.equal(again.added.length, 1);
	assert.deepEqual(again.skipped.map((item) => item.reason), ["already_member", "already_member"]);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM mail_group_members").get().n, 2);
});

test("invalid members are refused as a whole and nothing is stored", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup({});
	const attempt = async (member, status = 422, pattern) => {
		const response = await app.members.POST(req("POST", { members: [{ kind: "user", userId: "alice" }, member] }), ids(group.id));
		assert.equal(response.status, status, JSON.stringify(member));
		if (pattern) assert.match((await response.json()).error, pattern);
	};
	await attempt({ kind: "external", email: "x@example.com" }, 422, /domain/i);
	await attempt({ kind: "user", userId: "missing" }, 422, /account/i);
	await attempt({ kind: "user", userId: "off" }, 422, /disabled/i);
	await attempt({ kind: "mailbox", mailboxId: "m-alice" }, 422, /shared/i);
	await attempt({ kind: "mailbox", mailboxId: "m-xshared" }, 422, /mailbox/i);
	await attempt({ kind: "user", userId: "alice", mailboxId: "m-support" }, 400);
	await attempt({ kind: "mailbox", mailboxId: "m-support", canSendAs: true }, 422, /not available yet/i);
	await attempt({ kind: "user", userId: "bob", canSendAs: true }, 422, /not available yet/i);
	await attempt({ kind: "user" }, 400);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM mail_group_members").get().n, 0);
});

test("at most 50 members per call and 500 per group", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup({});
	const many = Array.from({ length: 51 }, () => ({ kind: "user", userId: "alice" }));
	assert.equal((await app.members.POST(req("POST", { members: many }), ids(group.id))).status, 400);
	const insert = sqlite.prepare("INSERT INTO mail_group_members (id, group_id, kind, user_id, created_at) VALUES (?, ?, 'user', 'alice', 1)");
	sqlite.exec("PRAGMA foreign_keys = OFF; DROP INDEX mail_group_members_group_user_idx");
	for (let i = 0; i < 499; i += 1) insert.run(`gmb${i}`, group.id);
	const response = await app.members.POST(req("POST", { members: [{ kind: "user", userId: "bob" }, { kind: "mailbox", mailboxId: "m-ops" }] }), ids(group.id));
	assert.equal(response.status, 422);
	assert.match((await response.json()).error, /500 members/);
});

test("member inserts stay under the bound-parameter limit", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup({});
	for (let i = 0; i < 40; i += 1) sqlite.exec(`INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('u${i}', 'u${i}@example.com', 'h', 'U${i}', 'user', 1)`);
	const params = [];
	const original = sqlite.prepare.bind(sqlite);
	sqlite.prepare = (sql) => { const statement = original(sql); for (const name of ["run", "all", "get", "values"]) { const fn = statement[name]; statement[name] = (...args) => { if (/insert into "mail_group_members"/i.test(sql)) params.push(args.length); return fn.apply(statement, args); }; } return statement; };
	const response = await app.members.POST(req("POST", { members: Array.from({ length: 40 }, (_, i) => ({ kind: "user", userId: `u${i}` })) }), ids(group.id));
	assert.equal(response.status, 200);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM mail_group_members").get().n, 40);
	for (const count of params) assert.ok(count <= 100, `bound ${count}`);
});

test("member updates only toggle send-as on user members", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup({});
	const body = await (await app.members.POST(req("POST", { members: [{ kind: "user", userId: "alice" }, { kind: "mailbox", mailboxId: "m-support" }] }), ids(group.id))).json();
	const user = body.added.find((m) => m.kind === "user");
	const mailbox = body.added.find((m) => m.kind === "mailbox");
	assert.equal((await app.member.PATCH(req("PATCH", { canSendAs: true }), ids(group.id, user.id))).status, 422, "send-as arrives with a later change");
	assert.equal((await app.member.PATCH(req("PATCH", { canSendAs: false }), ids(group.id, user.id))).status, 200);
	assert.deepEqual(audit(sqlite).at(-1), { action: "group.member_updated", actor_user_id: "admin", target_user_id: "alice", mailbox_id: null, metadata: { groupId: group.id, address: "team@example.com", kind: "user", canSendAs: false } });
	assert.equal((await app.member.PATCH(req("PATCH", { canSendAs: false }), ids(group.id, mailbox.id))).status, 422);
	assert.equal((await app.member.PATCH(req("PATCH", {}), ids(group.id, user.id))).status, 400);
	assert.equal((await app.member.PATCH(req("PATCH", { canSendAs: true }), ids(group.id, "missing"))).status, 404);
});

test("removing a member deletes the row and audits it", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup({});
	const body = await (await app.members.POST(req("POST", { members: [{ kind: "mailbox", mailboxId: "m-support" }] }), ids(group.id))).json();
	const response = await app.member.DELETE(req("DELETE"), ids(group.id, body.added[0].id));
	assert.equal(response.status, 200);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM mail_group_members").get().n, 0);
	assert.deepEqual(audit(sqlite).at(-1), { action: "group.member_removed", actor_user_id: "admin", target_user_id: null, mailbox_id: "m-support", metadata: { groupId: group.id, address: "team@example.com", kind: "mailbox" } });
	assert.equal((await app.member.DELETE(req("DELETE"), ids(group.id, body.added[0].id))).status, 404);
});

test("member routes will not touch another admin's group", async (t) => {
	const { sqlite } = await ctx(t);
	sqlite.exec(`INSERT INTO mail_groups (id, domain_id, local_part, name, created_at, updated_at) VALUES ('gx', 'dx', 'secret', 'Hidden', 1, 1)`);
	assert.equal((await app.members.POST(req("POST", { members: [{ kind: "user", userId: "alice" }] }), ids("gx"))).status, 404);
	assert.equal((await app.item.PATCH(req("PATCH", { name: "x" }), ids("gx"))).status, 404);
	assert.equal((await app.item.DELETE(req("DELETE"), ids("gx"))).status, 404);
	assert.equal((await app.candidates.GET(req("GET"), ids("gx"))).status, 404);
});

test("candidates search accounts and shared mailboxes, without current members", async (t) => {
	await ctx(t);
	const group = await makeGroup({});
	await app.members.POST(req("POST", { members: [{ kind: "user", userId: "bob" }] }), ids(group.id));
	const search = async (q) => (await (await app.candidates.GET(new Request(`https://x.test/api/groups/${group.id}/candidates?q=${q}`), ids(group.id))).json()).candidates;
	assert.deepEqual((await search("ali")).map((c) => [c.kind, c.id, c.address]), [["user", "alice", "alice@example.com"]]);
	assert.deepEqual((await search("bob")).length, 0, "already a member");
	assert.deepEqual((await search("off")).length, 0, "disabled accounts are not offered");
	assert.deepEqual((await search("supp")).map((c) => [c.kind, c.id, c.address]), [["mailbox", "m-support", "support@example.com"]]);
	assert.deepEqual((await search("xshared")).length, 0, "another admin's mailbox");
	assert.equal((await search("")).length <= 20, true);
});

test("a batch that hits a conflict stores none of its members and audits nothing", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup({});
	for (let i = 0; i < 40; i += 1) sqlite.exec(`INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('u${i}', 'u${i}@example.com', 'h', 'U${i}', 'user', 1)`);
	// A concurrent add of u35 lands after validation: the unique index then fails the whole batch.
	sqlite.exec(`CREATE TRIGGER race BEFORE INSERT ON mail_group_members WHEN NEW.user_id = 'u30' BEGIN INSERT INTO mail_group_members (id, group_id, kind, user_id, created_at) VALUES ('raced', NEW.group_id, 'user', 'u35', 1); END`);
	const response = await app.members.POST(req("POST", { members: Array.from({ length: 40 }, (_, i) => ({ kind: "user", userId: `u${i}` })) }), ids(group.id));
	assert.equal(response.status, 409);
	assert.deepEqual(sqlite.prepare("SELECT id FROM mail_group_members").all(), [], "all or nothing");
	assert.equal(audit(sqlite).filter((entry) => entry.action === "group.member_added").length, 0);
});

test("a member added by a concurrent request cannot push the group past 500", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup({});
	sqlite.exec("PRAGMA foreign_keys = OFF; DROP INDEX mail_group_members_group_user_idx");
	const insert = sqlite.prepare("INSERT INTO mail_group_members (id, group_id, kind, user_id, created_at) VALUES (?, ?, 'user', 'alice', 1)");
	for (let i = 0; i < 499; i += 1) insert.run(`gmb${i}`, group.id);
	sqlite.exec(`CREATE TRIGGER race AFTER INSERT ON mail_group_members WHEN NEW.user_id = 'bob' BEGIN INSERT INTO mail_group_members (id, group_id, kind, mailbox_id, created_at) VALUES ('raced', NEW.group_id, 'mailbox', 'm-ops', 1); END`);
	const response = await app.members.POST(req("POST", { members: [{ kind: "user", userId: "bob" }] }), ids(group.id));
	assert.equal(response.status, 422);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM mail_group_members WHERE user_id = 'bob'").get().n, 0, "the over-cap insert is rolled back");
	assert.match((await response.json()).error, /500 members/);
});

test("two dotted variants created at once do not both survive", async (t) => {
	const { sqlite } = await ctx(t);
	globalThis.grp.cf.onEnsure = (address) => {
		if (address === "john2@example.com") sqlite.exec(`INSERT INTO mail_groups (id, domain_id, local_part, name, created_at, updated_at) VALUES ('rival', 'd1', 'j.ohn2', 'Rival', 1, 1)`);
	};
	const response = await create({ localPart: "john2" });
	assert.equal(response.status, 409);
	assert.match((await response.json()).error, /group already uses/i);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM mail_groups WHERE local_part = 'john2'").get().n, 0, "the loser is removed");
	assert.deepEqual(globalThis.grp.cf.rolledBack, ["r-john2@example.com"]);
});

test("a dotted variant that appears while the address is being changed restores the old one", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup({});
	globalThis.grp.cf.onEnsure = (address) => {
		if (address === "crew@example.com") sqlite.exec(`INSERT INTO mail_groups (id, domain_id, local_part, name, created_at, updated_at) VALUES ('rival', 'd1', 'c.rew', 'Rival', 1, 1)`);
	};
	const response = await app.item.PATCH(req("PATCH", { localPart: "crew" }), ids(group.id));
	assert.equal(response.status, 409);
	assert.equal(sqlite.prepare("SELECT local_part FROM mail_groups WHERE id = ?").get(group.id).local_part, "team");
	assert.deepEqual(globalThis.grp.cf.deleted, [], "the old rule stays");
});

test("a backed-out address change restores every field, not only the address", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup({ description: "Everyone" });
	globalThis.grp.cf.onEnsure = (address) => {
		if (address === "crew@example.com") sqlite.exec(`INSERT INTO mail_groups (id, domain_id, local_part, name, created_at, updated_at) VALUES ('rival', 'd1', 'c.rew', 'Rival', 1, 1)`);
	};
	const before = sqlite.prepare("SELECT * FROM mail_groups WHERE id = ?").get(group.id);
	const response = await app.item.PATCH(req("PATCH", { localPart: "crew", name: "Crew", description: "Other", whoCanPost: "members", replyTo: "group", disabled: true }), ids(group.id));
	assert.equal(response.status, 409);
	assert.deepEqual(sqlite.prepare("SELECT * FROM mail_groups WHERE id = ?").get(group.id), before);
	assert.deepEqual(globalThis.grp.cf.rolledBack, ["r-crew@example.com"]);
});

test("if the old address was taken meanwhile, the backout still rolls the new rule back and answers 409", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup({});
	globalThis.grp.cf.onEnsure = (address) => {
		if (address === "crew@example.com") sqlite.exec(`INSERT INTO mail_groups (id, domain_id, local_part, name, created_at, updated_at) VALUES ('rival', 'd1', 'c.rew', 'Rival', 1, 1)`);
	};
	// Another request takes the freed address the moment this update lands.
	sqlite.exec(`CREATE TRIGGER taken AFTER UPDATE ON mail_groups WHEN NEW.local_part = 'crew' BEGIN INSERT INTO mail_groups (id, domain_id, local_part, name, created_at, updated_at) VALUES ('taker', 'd1', 'team', 'Taker', 1, 1); END`);
	const response = await app.item.PATCH(req("PATCH", { localPart: "crew", name: "Crew" }), ids(group.id));
	assert.equal(response.status, 409);
	assert.deepEqual(globalThis.grp.cf.rolledBack, ["r-crew@example.com"], "the new rule is not left behind");
});

test("deleting a group removes group and members in one batch", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup({});
	await app.members.POST(req("POST", { members: [{ kind: "user", userId: "alice" }] }), ids(group.id));
	// If the group delete fails, the member delete must not have been kept.
	sqlite.exec(`CREATE TRIGGER keep BEFORE DELETE ON mail_groups BEGIN SELECT RAISE(ABORT, 'blocked'); END`);
	await assert.rejects(() => app.item.DELETE(req("DELETE"), ids(group.id)));
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM mail_group_members").get().n, 1);
	assert.deepEqual(globalThis.grp.cf.deleted, []);
});
