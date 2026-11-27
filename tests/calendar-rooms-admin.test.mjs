import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.roomsAdmin.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/api/auth": "export async function requireSessionUser(){const s=globalThis.roomsAdmin;return s.user?{user:s.user,error:null}:{user:null,error:Response.json({error:'Unauthorized'},{status:401})}}",
	"@/lib/auth/admin": "export function isPrimaryAdmin(user){return user.admin===true}",
	"@/lib/auth/origin": "export function hasValidSessionMutationOrigin(){return globalThis.roomsAdmin.origin}",
	"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canShareMailboxes:globalThis.roomsAdmin.team}}",
	"@/lib/mailboxes/audit": "export async function createAuditLog(env,input){globalThis.roomsAdmin.audit.push(input)}",
};
const fixture = await loadFixture({ name: "rooms-admin", entryPoint: "src/app/api/admin/calendar-resources/route.ts", mocks });
const { GET, POST, PATCH, DELETE } = await fixture.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.roomsAdmin; fixture.dispose(); });

function setup({ user = { id: "a", admin: true }, team = true } = {}) {
	sqlite?.close();
	sqlite = installSqlite("roomsAdmin", { schema, extra: { user, team, origin: true, audit: [] } });
	globalThis.roomsAdmin.db.batch = async (list) => { sqlite.exec("BEGIN"); try { for (const statement of list) await statement; sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; } };
	sqlite.exec("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('a', 'a@one.test', 'A', 'x', 'admin', 1)");
}
const send = (method, body) => new Request("https://m.test/api/admin/calendar-resources", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const audit = () => globalThis.roomsAdmin.audit;
const make = async (name = "Boardroom", extra = {}) => (await (await POST(send("POST", { name, ...extra }))).json()).resource;

test("only the primary administrator reaches it; everyone else is refused and nothing is written", async () => {
	setup({ user: { id: "b", admin: false } });
	assert.equal((await GET(new Request("https://m.test/x"))).status, 403);
	assert.equal((await POST(send("POST", { name: "R" }))).status, 403);
	assert.equal((await PATCH(send("PATCH", { id: "x" }))).status, 403);
	assert.equal((await DELETE(send("DELETE", { id: "x" }))).status, 403);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM calendar_resources").get().n, 0);
	globalThis.roomsAdmin.user = null;
	assert.equal((await GET(new Request("https://m.test/x"))).status, 401);
});

test("a bad origin is refused for every write", async () => {
	setup();
	globalThis.roomsAdmin.origin = false;
	for (const [method, handler] of [["POST", POST], ["PATCH", PATCH], ["DELETE", DELETE]]) assert.equal((await handler(send(method, { name: "R", id: "x" }))).status, 403, method);
});

test("GET lists every resource, disabled ones too, and says whether booking is available", async () => {
	setup();
	await make("Zed");
	await make("Alpha", { disabled: true });
	const body = await (await GET(new Request("https://m.test/x"))).json();
	assert.deepEqual(body.resources.map((room) => [room.name, room.disabled]), [["Alpha", true], ["Zed", false]]);
	assert.equal(body.available, true);
	globalThis.roomsAdmin.team = false;
	assert.equal((await (await GET(new Request("https://m.test/x"))).json()).available, false, "readable after a licence lapses");
});

test("POST creates a room, audits who and which, and needs a Team licence", async () => {
	setup();
	const response = await POST(send("POST", { name: "Boardroom", capacity: 12, location: "2nd floor" }));
	assert.equal(response.status, 201);
	const { resource } = await response.json();
	assert.deepEqual([resource.name, resource.capacity], ["Boardroom", 12]);
	assert.deepEqual(audit().map((entry) => [entry.action, entry.actorUserId, entry.metadata.resourceId, entry.metadata.name]), [["calendar.resource_created", "a", resource.id, "Boardroom"]]);
	globalThis.roomsAdmin.team = false;
	const refused = await POST(send("POST", { name: "Second" }));
	assert.deepEqual([refused.status, (await refused.json()).code], [403, "TEAM_REQUIRED"]);
	assert.equal(audit().length, 1);
});

test("POST answers 400 for bad input and 409 for a taken name, with nothing audited", async () => {
	setup();
	await make("Boardroom");
	assert.equal((await POST(send("POST", { name: "" }))).status, 400);
	assert.equal((await POST(new Request("https://m.test/x", { method: "POST", body: "{nope" }))).status, 400);
	const twin = await POST(send("POST", { name: "boardroom" }));
	assert.deepEqual([twin.status, (await twin.json()).code], [409, "NAME_TAKEN"]);
	assert.equal(audit().length, 1);
});

test("PATCH edits and audits the changed fields; disabling and renaming stay possible without a licence", async () => {
	setup();
	const room = await make("Boardroom");
	globalThis.roomsAdmin.team = false;
	const response = await PATCH(send("PATCH", { id: room.id, name: "Big room", disabled: true }));
	assert.equal(response.status, 200);
	assert.equal((await response.json()).resource.disabled, true);
	assert.deepEqual(audit().at(-1).metadata, { resourceId: room.id, name: "Big room", changed: ["name", "disabled"] });
	assert.equal((await PATCH(send("PATCH", { id: "nope", name: "x" }))).status, 404);
});

test("DELETE refuses while future bookings exist and names the count; force removes them and audits the events", async () => {
	setup();
	const room = await make("Boardroom");
	const start = Math.floor(Date.now() / 1000) + 86_400;
	sqlite.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at) VALUES ('e1', 'a', 't', ?, ?, 1, 1)").run(start, start + 3600);
	sqlite.prepare("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES ('b1', ?, 'e1', 'accepted', 1)").run(room.id);
	const refused = await DELETE(send("DELETE", { id: room.id }));
	assert.deepEqual([refused.status, (await refused.json()).code], [409, "HAS_BOOKINGS"]);
	assert.equal(audit().filter((entry) => entry.action === "calendar.resource_deleted").length, 0);
	const forced = await DELETE(send("DELETE", { id: room.id, force: true }));
	assert.equal(forced.status, 200);
	assert.deepEqual((await forced.json()).eventIds, ["e1"]);
	assert.deepEqual(audit().at(-1).metadata, { resourceId: room.id, name: "Boardroom", force: true, eventIds: ["e1"], bookings: 1 });
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM calendar_events").get().n, 1);
	assert.equal((await DELETE(send("DELETE", { id: room.id }))).status, 404);
});
