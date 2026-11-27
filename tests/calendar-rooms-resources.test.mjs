import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const fixture = await loadFixture({ name: "cal-rooms-resources", entryPoint: "src/lib/calendar/resources.ts", mocks: {} });
const lib = await fixture.import();
const { MAX_RESOURCES, MAX_EVENT_RESOURCES, listResources, createResource, updateResource, deleteResource, resolveBookableRooms } = lib;
let sqlite;
after(() => { sqlite?.close(); delete globalThis.res; fixture.dispose(); });

const NOW = new Date(Date.UTC(2030, 0, 1));
const secs = (ms) => Math.floor(ms / 1000);
function setup() {
	sqlite?.close();
	installSqlite("res", { schema });
	sqlite = globalThis.res.sqlite;
	const db = globalThis.res.db;
	db.batch = async (list) => { sqlite.exec("BEGIN"); try { for (const statement of list) await statement; sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; } };
	sqlite.exec("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'u1@one.test', 'U', 'x', 'admin', 1)");
	return db;
}
function booking(resource, id, start, end, extra = {}, status = "accepted") {
	const row = { repeat: "none", ...extra };
	sqlite.prepare(`INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, repeat, repeat_until, created_at, updated_at) VALUES (?, 'u1', 't', ?, ?, ?, ?, 1, 1)`).run(id, secs(start), secs(end), row.repeat, row.repeat_until ?? null);
	sqlite.prepare("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES (?, ?, ?, ?, 1)").run(`b_${id}`, resource, id, status);
}

test("create validates and trims: name 1-120 characters, kind, capacity, location and description lengths", async () => {
	const db = setup();
	const ok = await createResource(db, "u1", { name: "  Boardroom ", kind: "room", capacity: 12, location: "2nd floor", description: "Projector" });
	assert.equal(ok.ok, true);
	assert.deepEqual([ok.resource.name, ok.resource.kind, ok.resource.capacity, ok.resource.location, ok.resource.disabled], ["Boardroom", "room", 12, "2nd floor", false]);
	for (const bad of [{ name: "" }, { name: "   " }, { name: "x".repeat(121) }, { name: "A", kind: "car" }, { name: "A", capacity: 0 }, { name: "A", capacity: 1.5 }, { name: "A", capacity: "12" }, { name: "A", capacity: 100001 }, { name: "A", location: "x".repeat(201) }, { name: "A", description: "x".repeat(1001) }, { name: 5 }, { name: "A", disabled: "no" }]) {
		const refused = await createResource(db, "u1", bad);
		assert.equal(refused.ok, false, JSON.stringify(bad));
		assert.equal(refused.status, 400);
	}
	const plain = await createResource(db, "u1", { name: "Phone booth" });
	assert.deepEqual([plain.resource.kind, plain.resource.capacity, plain.resource.location], ["room", null, ""]);
});

test("names are unique ignoring case, and 500 resources is the limit", async () => {
	const db = setup();
	await createResource(db, "u1", { name: "Boardroom" });
	const twin = await createResource(db, "u1", { name: "boardROOM" });
	assert.deepEqual([twin.ok, twin.status, twin.code], [false, 409, "NAME_TAKEN"]);
	assert.equal(MAX_RESOURCES, 500);
	sqlite.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 499) INSERT INTO calendar_resources (id, name, created_at, updated_at) SELECT 'r' || i, 'Room ' || i, 1, 1 FROM n");
	const over = await createResource(db, "u1", { name: "One too many" });
	assert.deepEqual([over.ok, over.status, over.code], [false, 409, "RESOURCE_LIMIT"]);
});

test("update changes only the named fields, refuses a taken name and an unknown id", async () => {
	const db = setup();
	const a = (await createResource(db, "u1", { name: "A", capacity: 4 })).resource;
	await createResource(db, "u1", { name: "B" });
	const renamed = await updateResource(db, { id: a.id, name: "A2", disabled: true });
	assert.deepEqual([renamed.ok, renamed.resource.name, renamed.resource.capacity, renamed.resource.disabled], [true, "A2", 4, true]);
	assert.equal((await updateResource(db, { id: a.id, capacity: null })).resource.capacity, null);
	assert.equal((await updateResource(db, { id: a.id, name: "b" })).code, "NAME_TAKEN");
	assert.equal((await updateResource(db, { id: a.id, name: "A2" })).ok, true, "keeping its own name is not a clash");
	assert.equal((await updateResource(db, { id: "nope", name: "x" })).status, 404);
	assert.equal((await updateResource(db, { name: "x" })).status, 400);
});

test("the list is every resource for an admin and only enabled ones for pickers", async () => {
	const db = setup();
	await createResource(db, "u1", { name: "Zed" });
	const hidden = (await createResource(db, "u1", { name: "Alpha", disabled: true })).resource;
	assert.deepEqual((await listResources(db, { includeDisabled: true })).map((room) => room.name), ["Alpha", "Zed"]);
	assert.deepEqual((await listResources(db, { includeDisabled: false })).map((room) => room.name), ["Zed"]);
	assert.equal(hidden.disabled, true);
});

test("delete is refused while future accepted bookings exist unless forced, then the bookings go and the events are named", async () => {
	const db = setup();
	const room = (await createResource(db, "u1", { name: "R" })).resource;
	booking(room.id, "past", NOW.getTime() - 86_400_000, NOW.getTime() - 82_800_000);
	booking(room.id, "later", NOW.getTime() + 86_400_000, NOW.getTime() + 90_000_000);
	booking(room.id, "series", NOW.getTime() - 86_400_000 * 30, NOW.getTime() - 86_400_000 * 30 + 3_600_000, { repeat: "weekly" });
	booking(room.id, "lost", NOW.getTime() + 86_400_000, NOW.getTime() + 90_000_000, {}, "declined");
	const refused = await deleteResource(db, room.id, false, { now: NOW });
	assert.deepEqual([refused.ok, refused.status, refused.code, refused.bookings], [false, 409, "HAS_BOOKINGS", 2]);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM calendar_resources").get().n, 1);
	const forced = await deleteResource(db, room.id, true, { now: NOW });
	assert.equal(forced.ok, true);
	assert.deepEqual([...forced.eventIds].sort(), ["later", "series"]);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM calendar_resources").get().n, 0);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM calendar_resource_bookings").get().n, 0);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM calendar_events").get().n, 4, "the events stay; only the room goes");
});

test("a room with only past bookings is deleted without force", async () => {
	const db = setup();
	const room = (await createResource(db, "u1", { name: "R" })).resource;
	booking(room.id, "past", NOW.getTime() - 86_400_000, NOW.getTime() - 82_800_000);
	booking(room.id, "ended", NOW.getTime() - 86_400_000 * 30, NOW.getTime() - 86_400_000 * 30 + 3_600_000, { repeat: "weekly", repeat_until: secs(NOW.getTime() - 86_400_000) });
	assert.equal((await deleteResource(db, room.id, false, { now: NOW })).ok, true);
	assert.equal((await deleteResource(db, room.id, false, { now: NOW })).status, 404);
});

test("rooms for an event: at most five, all known, enabled unless already booked, and a lapsed licence only keeps what exists", async () => {
	const db = setup();
	const ids = [];
	for (const name of ["A", "B", "C", "D", "E", "F"]) ids.push((await createResource(db, "u1", { name })).resource.id);
	await updateResource(db, { id: ids[5], disabled: true });
	assert.equal(MAX_EVENT_RESOURCES, 5);
	assert.deepEqual(await resolveBookableRooms(db, ids.slice(0, 2), { booked: [], canBook: true }), { ok: true, ids: ids.slice(0, 2) });
	assert.deepEqual(await resolveBookableRooms(db, [ids[0], ids[0]], { booked: [], canBook: true }), { ok: true, ids: [ids[0]] });
	const six = await resolveBookableRooms(db, ids, { booked: [], canBook: true });
	assert.deepEqual([six.ok, six.status], [false, 400]);
	assert.equal((await resolveBookableRooms(db, ["nope"], { booked: [], canBook: true })).status, 400);
	assert.equal((await resolveBookableRooms(db, [ids[5]], { booked: [], canBook: true })).status, 400, "a disabled room is not offered");
	assert.equal((await resolveBookableRooms(db, [ids[5]], { booked: [ids[5]], canBook: true })).ok, true, "but an existing booking of it stays");
	const lapsed = await resolveBookableRooms(db, [ids[0], ids[1]], { booked: [ids[0]], canBook: false });
	assert.deepEqual([lapsed.ok, lapsed.status, lapsed.code], [false, 403, "TEAM_REQUIRED"]);
	assert.equal((await resolveBookableRooms(db, [ids[0]], { booked: [ids[0]], canBook: false })).ok, true, "keeping what is booked is not a new booking");
	assert.equal((await resolveBookableRooms(db, [], { booked: [ids[0]], canBook: false })).ok, true, "removing is always possible");
	assert.equal((await resolveBookableRooms(db, "x", { booked: [], canBook: true })).status, 400);
});
