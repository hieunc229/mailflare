import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = OFF;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const mocks = {
	"@/db": "export function getDb(){return globalThis.orgFb.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/api/auth": "export async function requireSessionUser(){const s=globalThis.orgFb;return s.user?{user:s.user,error:null}:{user:null,error:Response.json({error:'Unauthorized'},{status:401})}}",
	"@/lib/auth/admin": "export function isPrimaryAdmin(user){return user.admin===true}",
	"@/lib/auth/origin": "export function hasValidSessionMutationOrigin(){return globalThis.orgFb.origin}",
	"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canShareMailboxes:globalThis.orgFb.team}}",
	"@/lib/mailboxes/audit": "export async function createAuditLog(env,input){globalThis.orgFb.audit.push(input)}",
};
const fixture = await loadFixture({ name: "org-fb-admin", entryPoint: "src/app/api/admin/calendar-free-busy/route.ts", mocks });
const { GET, PUT } = await fixture.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.orgFb; fixture.dispose(); });

function setup({ user = { id: "a", admin: true }, team = true } = {}) {
	sqlite?.close();
	sqlite = installSqlite("orgFb", { schema, extra: { user, team, origin: true, audit: [] } });
}
const put = (body) => PUT(new Request("https://m.test/api/admin/calendar-free-busy", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
const get = async () => (await GET(new Request("https://m.test/api/admin/calendar-free-busy"))).json();
const stored = () => sqlite.prepare("SELECT calendar_org_free_busy AS v FROM app_settings WHERE id = 'default'").get()?.v ?? 0;
const audit = () => globalThis.orgFb.audit;

test("it is off by default and offered only on a Team licence", async () => {
	setup();
	assert.deepEqual(await get(), { available: true, enabled: false });
	setup({ team: false });
	assert.deepEqual(await get(), { available: false, enabled: false });
});

test("the primary administrator turns it on and off; each change is audited with who and the new value", async () => {
	setup();
	const on = await put({ enabled: true });
	assert.equal(on.status, 200);
	assert.deepEqual(await on.json(), { available: true, enabled: true });
	assert.equal(stored(), 1);
	assert.deepEqual(audit().map((entry) => [entry.action, entry.actorUserId, entry.metadata.enabled]), [["calendar.org_free_busy_changed", "a", true]]);
	await put({ enabled: false });
	assert.equal(stored(), 0);
	assert.equal(audit().length, 2);
	assert.equal(audit()[1].metadata.enabled, false);
});

test("saving the value it already has changes and audits nothing", async () => {
	setup();
	await put({ enabled: false });
	assert.equal(audit().length, 0);
	await put({ enabled: true });
	await put({ enabled: true });
	assert.equal(audit().length, 1);
});

test("without a Team licence it cannot be turned on (403), but it can still be turned off", async () => {
	setup({ team: false });
	const refused = await put({ enabled: true });
	assert.equal(refused.status, 403);
	assert.equal((await refused.json()).code, "TEAM_REQUIRED", "a licence refusal is told apart from a permission one");
	assert.equal(stored(), 0);
	assert.equal(audit().length, 0);
	sqlite.exec("INSERT INTO app_settings (id, calendar_org_free_busy, updated_at) VALUES ('default', 1, 1) ON CONFLICT(id) DO UPDATE SET calendar_org_free_busy = 1");
	assert.equal((await put({ enabled: false })).status, 200);
	assert.equal(stored(), 0);
	assert.equal(audit().length, 1);
});

test("only the primary administrator, from the same origin, with a boolean", async () => {
	setup({ user: { id: "u", admin: false } });
	const forbidden = await put({ enabled: true });
	assert.equal(forbidden.status, 403);
	assert.equal((await forbidden.json()).code, undefined, "not a licence matter");
	assert.equal((await GET(new Request("https://m.test/x"))).status, 403);
	setup();
	globalThis.orgFb.origin = false;
	assert.equal((await put({ enabled: true })).status, 403);
	globalThis.orgFb.origin = true;
	assert.equal((await put({ enabled: "yes" })).status, 400);
	assert.equal((await put({})).status, 400);
	assert.equal(stored(), 0);
	setup({ user: null });
	assert.equal((await put({ enabled: true })).status, 401);
});
