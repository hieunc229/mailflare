import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { build } from "esbuild";

const project = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(project, "node_modules", "permission-test-"));
after(() => rmSync(temporary, { recursive: true, force: true }));
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.permissionDb}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/auth/cookies": "export async function requireUser(){return globalThis.permissionUser}",
	"@/lib/api/auth": "export async function requireSessionUser(){return globalThis.permissionUser?{user:globalThis.permissionUser,error:null}:{user:null,error:Response.json({error:'Unauthorized'},{status:401})}}",
	"@/lib/mailboxes/access": "export async function getMailboxAccessLevel(db,user,id){return globalThis.managedMailboxes.includes(id)?{canManage:true,mailbox:{id,domainId:'d-owner'}}:null} export async function listAccessibleMailboxes(){return []}",
};
await build({ stdin: { contents: `export * as domain from './src/app/api/routing-rules/domain/route';export * as domainItem from './src/app/api/routing-rules/domain/[id]/route';export * as mailbox from './src/app/api/routing-rules/route';export * as mailboxItem from './src/app/api/routing-rules/[id]/route';export * as schema from './src/db/schema';export {emptyRuleInput} from './src/components/settings/domain-routing/utils';`, resolveDir: project, loader: "ts" }, outfile: join(temporary, "routes.mjs"), bundle: true, platform: "node", format: "esm", packages: "external", alias: { "@": join(project, "src") }, plugins: [{ name: "test-auth-and-db", setup(builder) { builder.onResolve({ filter: /^(next\/server|@\/db|@\/lib\/(cloudflare|auth\/cookies|api\/auth|mailboxes\/access))$/ }, args => ({ path: args.path, namespace: "mock" })); builder.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ contents: mocks[args.path], loader: "js" })); } }], logLevel: "silent" });
const { domain, domainItem, mailbox, mailboxItem, schema, emptyRuleInput } = await import(pathToFileURL(join(temporary, "routes.mjs")).href);
const quote = value => `"${value.replaceAll('"', '""')}"`;
const owner = { id: "owner", role: "admin", isPrimaryAdmin: true, canManageDomains: false };
const manager = { id: "manager", role: "admin", isPrimaryAdmin: false, canManageDomains: true, createdByUserId: "owner" };
const ordinary = { id: "user", role: "user", isPrimaryAdmin: false, canManageDomains: false };
let sqlite;
function setup(user) {
	sqlite?.close(); sqlite = new DatabaseSync(":memory:");
	for (const value of Object.values(schema)) { let table; try { table = getTableConfig(value); } catch { continue; } sqlite.exec(`CREATE TABLE ${quote(table.name)} (${table.columns.map(column => `${quote(column.name)} ${column.getSQLType()}`).join(",")})`); }
	globalThis.permissionDb = drizzle(async (sql, params, method) => { const query = sqlite.prepare(sql); if (method === "run") { query.run(...params); return { rows: [] }; } query.setReturnArrays(true); return { rows: query.all(...params) }; });
	globalThis.permissionUser = user; globalThis.managedMailboxes = ["m-user", "m-shared"];
	sqlite.exec("INSERT INTO domains(id,user_id,hostname) VALUES ('d-owner','owner','example.test'),('d-other','other','other.test'),('d-self','manager','self.test'); INSERT INTO mailboxes(id,user_id,domain_id,local_part,disabled) VALUES ('m-user','user','d-owner','user',0),('m-shared','owner','d-owner','team',0),('m-other','other','d-other','other',0); INSERT INTO routing_rules(id,user_id,domain_id,scope,mailbox_id,match_field,match_operator,match_value,action,enabled,keep_copy,priority,created_at) VALUES ('r-domain','owner','d-owner','domain','m-user','recipient','exact','*','store',1,0,100,0),('r-mailbox','user','d-owner','mailbox','m-user','sender','contains','news','spam',1,0,10,0),('r-other','other','d-other','domain','m-other','recipient','exact','*','store',1,0,100,0);");
}
after(() => { sqlite?.close(); delete globalThis.permissionDb; delete globalThis.permissionUser; delete globalThis.managedMailboxes; });
const input = overrides => ({ ...emptyRuleInput("d-owner"), matchValue: "*", mailboxId: "m-user", ...overrides });
const request = (path, method = "GET", body, origin = "https://mail.test") => new Request(`https://mail.test${path}`, { method, headers: { Origin: origin, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
const context = id => ({ params: Promise.resolve({ id }) });

test("mailbox owners, full-access sharers and mailbox-only admins cannot use any domain rule API", async () => {
	for (const user of [ordinary, { ...ordinary, id: "shared-user" }, { id: "mailbox-admin", role: "admin", isPrimaryAdmin: false, canManageMailboxes: true, canManageDomains: false, createdByUserId: "owner" }, { ...ordinary, canManageDomains: true }]) {
		setup(user);
		assert.equal((await domain.GET(request("/api/routing-rules/domain?list=true"))).status, 403);
		for (const suffix of ["", "&mailboxId=m-user", "&mailboxId=m-shared"]) {
			assert.equal((await domain.GET(request(`/api/routing-rules/domain?domainId=d-owner${suffix}`))).status, 403);
			assert.equal((await domain.POST(request(`/api/routing-rules/domain?x=1${suffix}`, "POST", input()))).status, 403);
			assert.equal((await domainItem.PATCH(request(`/api/routing-rules/domain/r-domain?x=1${suffix}`, "PATCH", input()), context("r-domain"))).status, 403);
			assert.equal((await domainItem.DELETE(request(`/api/routing-rules/domain/r-domain?x=1${suffix}`, "DELETE"), context("r-domain"))).status, 403);
		}
		assert.equal(sqlite.prepare("SELECT action FROM routing_rules WHERE id='r-domain'").get().action, "store");
	}
});
test("primary/domain admins retain CRUD, same-domain destinations and owner isolation", async () => {
	for (const user of [owner, manager]) {
		setup(user);
		const listed = await domain.GET(request("/api/routing-rules/domain?list=true"));
		assert.equal(listed.status, 200);
		assert.deepEqual((await listed.json()).domains.map(item => item.id).sort(), user === owner ? ["d-owner"] : ["d-owner", "d-self"]);
		assert.equal((await domain.GET(request("/api/routing-rules/domain?domainId=d-owner&mailboxId=m-user"))).status, 200);
		assert.equal((await domain.POST(request("/api/routing-rules/domain", "POST", input()))).status, 200);
		assert.equal((await domainItem.PATCH(request("/api/routing-rules/domain/r-domain", "PATCH", input({ action: "reject", mailboxId: null })), context("r-domain"))).status, 200);
		assert.equal((await domain.GET(request("/api/routing-rules/domain?domainId=d-other"))).status, 403);
		assert.equal((await domain.POST(request("/api/routing-rules/domain", "POST", input({ mailboxId: "m-other" })))).status, 403);
		assert.equal((await domainItem.PATCH(request("/api/routing-rules/domain/r-domain", "PATCH", input({ domainId: "d-other", mailboxId: "m-other" })), context("r-domain"))).status, 403);
		assert.equal((await domainItem.DELETE(request("/api/routing-rules/domain/r-other", "DELETE"), context("r-other"))).status, 403);
		assert.equal((await domainItem.DELETE(request("/api/routing-rules/domain/r-domain", "DELETE"), context("r-domain"))).status, 200);
	}
	setup(manager); assert.equal((await domain.GET(request("/api/routing-rules/domain?domainId=d-self"))).status, 200);
});
test("mailbox routes cannot modify domain rules even with the destination inbox permission", async () => {
	setup(ordinary);
	const payload = { mailboxId: "m-user", matchField: "email", matchOperator: "contains", matchValue: "news", destination: "spam", priority: 100 };
	assert.equal((await mailboxItem.PATCH(request("/api/routing-rules/r-domain", "PATCH", payload), context("r-domain"))).status, 404);
	assert.equal((await mailboxItem.DELETE(request("/api/routing-rules/r-domain", "DELETE"), context("r-domain"))).status, 404);
	const listed = await (await mailbox.GET(request("/api/routing-rules?mailboxId=m-user"))).json(); assert.deepEqual(listed.rules.map(rule => rule.id), ["r-mailbox"]);
	assert.equal((await mailbox.POST(request("/api/routing-rules", "POST", payload))).status, 200);
	assert.equal((await mailboxItem.PATCH(request("/api/routing-rules/r-mailbox", "PATCH", payload), context("r-mailbox"))).status, 200);
	assert.equal((await mailboxItem.DELETE(request("/api/routing-rules/r-mailbox", "DELETE"), context("r-mailbox"))).status, 200);
});
test("cross-origin domain mutations and unauthenticated callers are denied", async () => {
	setup(owner);
	assert.equal((await domain.POST(request("/api/routing-rules/domain", "POST", input(), "https://evil.test"))).status, 403);
	assert.equal((await domainItem.PATCH(request("/api/routing-rules/domain/r-domain", "PATCH", input(), "https://evil.test"), context("r-domain"))).status, 403);
	assert.equal((await domainItem.DELETE(request("/api/routing-rules/domain/r-domain", "DELETE", undefined, "https://evil.test"), context("r-domain"))).status, 403);
	globalThis.permissionUser = null; assert.equal((await domain.GET(request("/api/routing-rules/domain?domainId=d-owner"))).status, 401);
});
