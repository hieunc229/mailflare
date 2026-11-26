import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const stubRoute = (names) => names.map((n) => `export async function ${n}(){throw new Error("not under test")}`).join(";");
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/lib/cloudflare": "export function getEnv(){return globalThis.g1.env}",
	"@/lib/api/auth": "export async function authenticateApiKey(env,header){const k=globalThis.g1.keys[(header||'').replace('Bearer ','')];return k??null}; export async function requireSessionUser(){throw new Error('session auth must not be used by v1')}",
	"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canManageAccounts:globalThis.g1.licensed}}",
	"@/lib/deliverability/report-address": "export async function isReportAddressReserved(){return false}",
	"@/lib/cloudflare-api": `
		export async function ensureEmailRoutingRuleToWorker(env,zone,address,changes){globalThis.g1.ensured.push(address);changes?.push({zoneId:zone,ruleId:'r-'+address})}
		export async function deleteEmailRoutingRuleForAddress(env,zone,address){return true}
		export async function rollbackEmailRoutingRuleChanges(){}
	`,
	"@/lib/auth/origin": "export function hasValidSessionMutationOrigin(){return true}",
	"@/app/api/v1/domains/route": stubRoute(["GET", "POST"]),
	"@/app/api/v1/domains/[id]/route": stubRoute(["GET", "DELETE"]),
	"@/app/api/v1/domains/[id]/dns/route": stubRoute(["GET"]),
	"@/app/api/v1/domains/[id]/dns/setup/route": stubRoute(["POST"]),
	"@/app/api/v1/accounts/route": stubRoute(["GET", "POST"]),
	"@/app/api/v1/accounts/[id]/route": stubRoute(["GET", "PATCH"]),
	"@/app/api/v1/mailboxes/route": stubRoute(["GET", "POST"]),
	"@/app/api/v1/mailboxes/[id]/route": stubRoute(["GET", "PATCH", "DELETE"]),
	"@/app/api/v1/storage/route": stubRoute(["GET", "POST"]),
};
const { app, newDatabase } = await loadApp("groups-send-as-v1", `
	export * as list from "./src/app/api/v1/groups/route.ts";
	export * as item from "./src/app/api/v1/groups/[id]/route.ts";
	export * as members from "./src/app/api/v1/groups/[id]/members/route.ts";
	export { registerAdminMcpTools } from "./src/lib/mcp/admin-tools.ts";
	export { ADMIN_API_KEY_SCOPES } from "./src/lib/api/scopes.ts";
`, { mocks });

const seed = `
	INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, can_manage_users, created_at) VALUES
		('admin', 'admin@example.com', 'hash', 'Admin', 'admin', 1, 1, 1),
		('alice', 'alice@example.com', 'hash', 'Alice Doe', 'user', 0, 0, 1);
	INSERT INTO domains (id, user_id, hostname, zone_id, status, receiving_provider, created_at) VALUES ('d1', 'admin', 'example.com', 'z1', 'active', 'cloudflare', 1);
	INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, use_all_domains, created_at) VALUES ('m-alice', 'alice', 'd1', 'alice', 'personal', 0, 1);
`;
const adminUser = { id: "admin", role: "admin", isPrimaryAdmin: true, canManageUsers: true, canManageMailboxes: true, createdByUserId: null, email: "admin@example.com" };
const keyFor = (scopes, user = adminUser) => ({ keyId: "key-1", userId: user.id, user, scopes });

async function ctx(t, { licensed = true } = {}) {
	const database = await newDatabase(t, seed);
	globalThis.g1 = { env: database.env, licensed, ensured: [], keys: { good: keyFor(["groups"]), other: keyFor(["mailboxes"]), plain: keyFor(["groups"], { ...adminUser, role: "user" }) } };
	t.after(() => { delete globalThis.g1; });
	return database;
}
const req = (method, body, key = "good", query = "") => new Request(`https://x.test/api/v1/groups${query}`, {
	method,
	headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
	...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const ctxId = (id) => ({ params: Promise.resolve({ id }) });
const audit = (sqlite) => sqlite.prepare("SELECT action, actor_user_id FROM audit_logs ORDER BY rowid").all();
async function makeGroup() {
	const response = await app.list.POST(req("POST", { domainId: "d1", localPart: "team", name: "Team" }));
	assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
	return (await response.json()).group;
}

function mcpTool(scopes) {
	const tools = new Map();
	app.registerAdminMcpTools({ registerTool: (name, def, handler) => tools.set(name, handler) }, { scopes }, "https://x.test", "Bearer good");
	return tools;
}
const flag = (sqlite) => sqlite.prepare("SELECT can_send_as FROM mail_group_members WHERE user_id = 'alice'").get()?.can_send_as;

test("v1: a user member is added with canSendAs, toggled off and on, and each change is audited", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup();
	const added = await app.members.POST(req("POST", { members: [{ kind: "user", userId: "alice", canSendAs: true }] }), ctxId(group.id));
	assert.equal(added.status, 200, JSON.stringify(await added.clone().json()));
	const member = (await added.json()).added[0];
	assert.equal(member.canSendAs, true);
	assert.equal(flag(sqlite), 1);
	const off = await app.members.PATCH(req("PATCH", { canSendAs: false }, "good", `?memberId=${member.id}`), ctxId(group.id));
	assert.equal(off.status, 200);
	assert.equal((await off.json()).member.canSendAs, false);
	assert.equal(flag(sqlite), 0);
	const on = await app.members.PATCH(req("PATCH", { canSendAs: true }, "good", `?memberId=${member.id}`), ctxId(group.id));
	assert.equal((await on.json()).member.canSendAs, true);
	assert.deepEqual(audit(sqlite).map((r) => r.action), ["group.created", "group.member_added", "group.member_updated", "group.member_updated"]);
});

test("v1: canSendAs on an outside address is refused with 422", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup();
	const response = await app.members.POST(req("POST", { members: [{ kind: "external", email: "x@ext.com", canSendAs: true }] }), ctxId(group.id));
	assert.equal(response.status, 422);
	assert.match((await response.json()).error, /Only account members/);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM mail_group_members").get().n, 0);
});

test("manage_groups add_members passes canSendAs through", async (t) => {
	const { sqlite } = await ctx(t);
	const call = async (input) => { const r = await mcpTool(["groups"]).get("manage_groups")(input); return { ...JSON.parse(r.content[0].text), isError: r.isError }; };
	const created = await call({ action: "create", data: { domainId: "d1", localPart: "team", name: "Team" } });
	const id = created.data.group.id;
	const added = await call({ action: "add_members", id, data: { members: [{ kind: "user", userId: "alice", canSendAs: true }] } });
	assert.equal(added.status, 200, JSON.stringify(added));
	assert.equal(added.data.added[0].canSendAs, true);
	assert.equal(flag(sqlite), 1);
});
