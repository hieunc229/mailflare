import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const { app, newDatabase } = await loadApp("groups-v1", `
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

test("groups is an admin API key scope", () => {
	assert.ok(app.ADMIN_API_KEY_SCOPES.includes("groups"));
	assert.match(readFileSync(new URL("../src/lib/api/scopes-types.d.ts", import.meta.url), "utf8"), /"groups"/);
});

test("every v1 route needs the groups scope on an admin key", async (t) => {
	await ctx(t);
	const calls = [
		() => app.list.GET(req("GET", undefined, "nope")),
		() => app.list.GET(req("GET", undefined, "other")),
		() => app.list.POST(req("POST", {}, "plain")),
		() => app.item.GET(req("GET", undefined, "other"), ctxId("x")),
		() => app.item.PATCH(req("PATCH", {}, "other"), ctxId("x")),
		() => app.item.DELETE(req("DELETE", undefined, "other"), ctxId("x")),
		() => app.members.POST(req("POST", {}, "other"), ctxId("x")),
		() => app.members.DELETE(req("DELETE", undefined, "other", "?memberId=m"), ctxId("x")),
		() => app.members.PATCH(req("PATCH", { canSendAs: false }, "other", "?memberId=m"), ctxId("x")),
	];
	for (const call of calls) assert.equal((await call()).status, 401);
});

test("the accounts licence gates every route with LICENSE_REQUIRED", async (t) => {
	await ctx(t, { licensed: false });
	for (const response of [await app.list.GET(req("GET")), await app.list.POST(req("POST", {})), await app.item.GET(req("GET"), ctxId("x")), await app.item.PATCH(req("PATCH", {}), ctxId("x")), await app.item.DELETE(req("DELETE"), ctxId("x")), await app.members.POST(req("POST", {}), ctxId("x")), await app.members.PATCH(req("PATCH", { canSendAs: false }, "good", "?memberId=m"), ctxId("x")), await app.members.DELETE(req("DELETE", undefined, "good", "?memberId=m"), ctxId("x"))]) {
		assert.equal(response.status, 403);
		assert.equal((await response.json()).code, "LICENSE_REQUIRED");
	}
});

test("create, get, update, list and delete go through the shared service and audit the key owner", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup();
	assert.equal(group.address, "team@example.com");
	assert.deepEqual(globalThis.g1.ensured, ["team@example.com"]);
	const listed = await (await app.list.GET(req("GET"))).json();
	assert.equal(listed.groups?.length ?? listed.length, 1);
	assert.equal((await app.item.GET(req("GET"), ctxId(group.id))).status, 200);
	const patched = await app.item.PATCH(req("PATCH", { whoCanPost: "members" }), ctxId(group.id));
	assert.equal(patched.status, 200);
	assert.equal((await patched.json()).group.whoCanPost, "members");
	assert.equal((await app.item.DELETE(req("DELETE"), ctxId(group.id))).status, 200);
	assert.equal((await app.item.GET(req("GET"), ctxId(group.id))).status, 404);
	assert.deepEqual(audit(sqlite), [
		{ action: "group.created", actor_user_id: "admin" },
		{ action: "group.updated", actor_user_id: "admin" },
		{ action: "group.deleted", actor_user_id: "admin" },
	]);
});

test("a group on a domain the key owner does not own is a 404", async (t) => {
	const { sqlite } = await ctx(t);
	sqlite.exec("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('other', 'o@else.com', 'hash', 'O', 'admin', 1); INSERT INTO domains (id, user_id, hostname, zone_id, status, receiving_provider, created_at) VALUES ('dx', 'other', 'else.com', 'zx', 'active', 'cloudflare', 1);");
	assert.equal((await app.list.POST(req("POST", { domainId: "dx", localPart: "team", name: "Team" }))).status, 404);
	sqlite.exec("INSERT INTO mail_groups (id, domain_id, local_part, name, who_can_post, reply_to, disabled, created_by_user_id, created_at, updated_at) VALUES ('gx', 'dx', 'team', 'Team', 'anyone', 'sender', 0, 'other', 1, 1)");
	assert.equal((await app.item.GET(req("GET"), ctxId("gx"))).status, 404);
	assert.equal((await app.item.DELETE(req("DELETE"), ctxId("gx"))).status, 404);
	assert.equal((await app.members.POST(req("POST", { members: [{ kind: "user", userId: "alice" }] }), ctxId("gx"))).status, 404);
});

test("members: add, refuse an own-domain external and canSendAs with 422, remove by memberId", async (t) => {
	const { sqlite } = await ctx(t);
	const group = await makeGroup();
	const added = await app.members.POST(req("POST", { members: [{ kind: "user", userId: "alice" }] }), ctxId(group.id));
	assert.equal(added.status, 200, JSON.stringify(await added.clone().json()));
	const body = await added.json();
	const memberId = body.added[0].id;
	const external = await app.members.POST(req("POST", { members: [{ kind: "external", email: "x@example.com" }] }), ctxId(group.id));
	assert.equal(external.status, 422);
	const sendAs = await app.members.POST(req("POST", { members: [{ kind: "external", email: "x@ext.com", canSendAs: true }] }), ctxId(group.id));
	assert.equal(sendAs.status, 422);
	assert.equal((await app.members.DELETE(req("DELETE"), ctxId(group.id))).status, 400, "memberId is required");
	assert.equal((await app.members.DELETE(req("DELETE", undefined, "good", `?memberId=${memberId}`), ctxId(group.id))).status, 200);
	assert.deepEqual(audit(sqlite).map((r) => r.action), ["group.created", "group.member_added", "group.member_removed"]);
});

test("a missing groups table answers 503 MIGRATION_REQUIRED", async (t) => {
	const { sqlite } = await ctx(t);
	sqlite.exec("DROP TABLE mail_group_members; DROP TABLE mail_groups;");
	const response = await app.list.GET(req("GET"));
	assert.equal(response.status, 503);
	assert.equal((await response.json()).code, "MIGRATION_REQUIRED");
});

function mcpTool(scopes) {
	const tools = new Map();
	app.registerAdminMcpTools({ registerTool: (name, def, handler) => tools.set(name, handler) }, { scopes }, "https://x.test", "Bearer good");
	return tools;
}

test("manage_groups is registered only for the groups scope", () => {
	assert.ok(!mcpTool(["mailboxes"]).has("manage_groups"));
	assert.ok(mcpTool(["groups"]).has("manage_groups"));
});

test("manage_groups runs every action through the v1 routes", async (t) => {
	const { sqlite } = await ctx(t);
	const call = async (input) => { const r = await mcpTool(["groups"]).get("manage_groups")(input); return { ...JSON.parse(r.content[0].text), isError: r.isError }; };
	const created = await call({ action: "create", data: { domainId: "d1", localPart: "team", name: "Team" } });
	assert.equal(created.status, 201, JSON.stringify(created));
	const id = created.data.group.id;
	assert.equal((await call({ action: "list" })).status, 200);
	assert.equal((await call({ action: "get", id })).status, 200);
	assert.equal((await call({ action: "update", id, data: { description: "d" } })).status, 200);
	const added = await call({ action: "add_members", id, data: { members: [{ kind: "user", userId: "alice" }] } });
	assert.equal(added.status, 200);
	assert.equal((await call({ action: "add_members", id, data: { members: [{ kind: "external", email: "x@example.com" }] } })).status, 422);
	assert.equal((await call({ action: "remove_member", id, data: { memberId: added.data.added[0].id } })).status, 200);
	assert.equal((await call({ action: "delete", id })).status, 200);
	assert.equal((await call({ action: "get" })).isError, true, "id required");
	assert.equal((await call({ action: "remove_member", id })).isError, true, "memberId required");
	const unknown = await call({ action: "bogus" });
	assert.equal(unknown.isError, true);
	assert.equal(unknown.error, "Unknown action", "an unknown action is named as such even without an id");
	assert.ok(audit(sqlite).every((row) => row.actor_user_id === "admin"));
});
