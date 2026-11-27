import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

// CS-8 owner decision: a room is bookable from public booking pages only when an administrator switches that on (off by default, Team to turn on).
const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.pubAdmin.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/api/auth": "export async function requireSessionUser(){return {user:globalThis.pubAdmin.user,error:null}}",
	"@/lib/auth/admin": "export function isPrimaryAdmin(user){return user.admin===true}",
	"@/lib/auth/origin": "export function hasValidSessionMutationOrigin(){return true}",
	"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canShareMailboxes:globalThis.pubAdmin.team}}",
	"@/lib/mailboxes/audit": "export async function createAuditLog(env,input){globalThis.pubAdmin.audit.push(input)}",
};
const fixture = await loadFixture({ name: "pub-rooms-admin", entryPoint: "src/app/api/admin/calendar-resources/route.ts", mocks });
const { GET, POST, PATCH } = await fixture.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.pubAdmin; fixture.dispose(); });

function setup({ team = true } = {}) {
	sqlite?.close();
	sqlite = installSqlite("pubAdmin", { schema, extra: { user: { id: "a", admin: true }, team, audit: [] } });
	sqlite.exec("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('a', 'a@one.test', 'A', 'x', 'admin', 1)");
}
const send = (method, body) => new Request("https://m.test/api/admin/calendar-resources", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const audit = () => globalThis.pubAdmin.audit;

test("a new room is closed to public booking pages until an administrator opens it", async () => {
	setup();
	const created = await (await POST(send("POST", { name: "Boardroom" }))).json();
	const { resource } = created;
	assert.equal(resource.publicBooking, false);
	assert.equal(sqlite.prepare("SELECT public_booking AS p FROM calendar_resources").get().p, 0);
	const { resources } = await (await GET(new Request("https://m.test/x"))).json();
	assert.equal(resources[0].publicBooking, false);
});

test("opening it needs the Team licence, is audited, and the switch must be a boolean", async () => {
	setup();
	const { resource } = await (await POST(send("POST", { name: "Boardroom" }))).json();
	globalThis.pubAdmin.team = false;
	const refused = await PATCH(send("PATCH", { id: resource.id, publicBooking: true }));
	assert.equal(refused.status, 403);
	assert.equal((await refused.json()).code, "TEAM_REQUIRED");
	assert.equal(sqlite.prepare("SELECT public_booking AS p FROM calendar_resources").get().p, 0);
	globalThis.pubAdmin.team = true;
	assert.equal((await PATCH(send("PATCH", { id: resource.id, publicBooking: "yes" }))).status, 400);
	const opened = await PATCH(send("PATCH", { id: resource.id, publicBooking: true }));
	assert.equal(opened.status, 200);
	assert.equal((await opened.json()).resource.publicBooking, true);
	assert.deepEqual(audit().at(-1).metadata.changed, ["publicBooking"]);
	assert.equal(audit().at(-1).action, "calendar.resource_updated");
});

test("closing it is always allowed, with a lapsed licence too, and is audited", async () => {
	setup();
	const { resource } = await (await POST(send("POST", { name: "Boardroom", publicBooking: true }))).json();
	assert.equal(resource.publicBooking, true);
	globalThis.pubAdmin.team = false;
	assert.equal((await PATCH(send("PATCH", { id: resource.id, publicBooking: false }))).status, 200);
	assert.equal(sqlite.prepare("SELECT public_booking AS p FROM calendar_resources").get().p, 0);
	assert.deepEqual(audit().at(-1).metadata.changed, ["publicBooking"]);
});

test("creating a room records whether it was opened to public booking pages in the audit entry", async () => {
	setup();
	await POST(send("POST", { name: "Open", publicBooking: true }));
	await POST(send("POST", { name: "Closed" }));
	assert.deepEqual(audit().map((entry) => [entry.action, entry.metadata.name, entry.metadata.publicBooking]), [["calendar.resource_created", "Open", true], ["calendar.resource_created", "Closed", false]]);
});
