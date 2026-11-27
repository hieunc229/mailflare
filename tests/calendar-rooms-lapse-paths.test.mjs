import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

// M-5 on every re-check path: with the Team licence lapsed a declined room stays declined; with a licence it is checked again.
const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.roomLx.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/auth/cookies": "export async function getCurrentUser(){return globalThis.roomLx.user}",
	"@/lib/auth/origin": "export function hasValidSessionMutationOrigin(){return true}",
	"@/lib/licenses/service": "export async function getLicenseEntitlements(){return {canShareMailboxes:globalThis.roomLx.team}}",
	"./confirmation": "export const CONFIRMED_CALENDAR_TOOLS=new Set(['update_events','delete_events']); export async function createCalendarConfirmation(){return 'x'}",
};
const invite = await loadFixture({ name: "room-lx-invite", entryPoint: "src/lib/calendar/invite-store.ts", mocks });
const tools = await loadFixture({ name: "room-lx-tools", entryPoint: "src/lib/calendar/tools.ts", mocks });
const zone = await loadFixture({ name: "room-lx-zone", entryPoint: "src/app/api/settings/time-zone/route.ts", mocks });
const { registerInboundInvite, inviteEventId } = await invite.import();
const { runCalendarTool } = await tools.import();
const { PATCH: changeZone } = await zone.import();
const schedule = await loadFixture({ name: "room-lx-schedule", entryPoint: "src/lib/calendar/room-schedule.ts", mocks });
const { roomsByEvent } = await schedule.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.roomLx; for (const fixture of [invite, tools, zone, schedule]) fixture.dispose(); });

const FUTURE = Date.UTC(new Date().getUTCFullYear() + 1, 2, 4);
const H = 3_600_000;
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const ics = (start, end, sequence) => ["BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:meeting-1@host.test", `SEQUENCE:${sequence}`, `DTSTAMP:${stamp(FUTURE)}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`, "SUMMARY:Review", "ORGANIZER:mailto:boss@host.test", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
const receive = (body) => registerInboundInvite({}, { userId: "u1", mailboxId: "m1", messageId: "msg", senderAddress: "boss@host.test", attachments: [{ filename: "invite.ics", type: "text/calendar", content: new TextEncoder().encode(body).buffer }] });

function setup(team) {
	sqlite?.close();
	sqlite = installSqlite("roomLx", { schema, extra: { team, user: { id: "u1", timeZone: "UTC", calendarEnabled: true } } });
	globalThis.roomLx.db.batch = async (list) => { sqlite.exec("BEGIN"); try { for (const statement of list) await statement; sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; } };
	sqlite.exec("INSERT INTO users (id, email, name, password_hash, role, time_zone, created_at) VALUES ('u1', 'u1@one.test', 'U', 'x', 'user', 'UTC', 1)");
	sqlite.exec("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'one.test', 'z', 1)");
	sqlite.exec("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('m1', 'u1', 'd1', 'u1', 1)");
	sqlite.exec("INSERT INTO calendar_resources (id, name, created_at, updated_at) VALUES ('r1', 'Room one', 1, 1), ('r2', 'Room two', 1, 1)");
}
// r1 was declined (it was taken when booked) and is free now; r2 is accepted.
const book = (id) => sqlite.prepare("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES ('b1', 'r1', ?, 'declined', 1), ('b2', 'r2', ?, 'accepted', 1)").run(id, id);
const rooms = () => sqlite.prepare("SELECT resource_id, status FROM calendar_resource_bookings ORDER BY resource_id").all().map((row) => [row.resource_id, row.status]);
const LAPSED = [["r1", "declined"], ["r2", "accepted"]];
const LICENSED = [["r1", "accepted"], ["r2", "accepted"]];

for (const [team, expected] of [[false, LAPSED], [true, LICENSED]]) {
	const label = team ? "with a Team licence the free room is accepted" : "licence lapsed: the declined room stays declined";
	test(`invite update, ${label}`, async () => {
		setup(team);
		await receive(ics(FUTURE + 9 * H, FUTURE + 10 * H, 0));
		const id = await inviteEventId("u1", "meeting-1@host.test");
		book(id);
		await receive(ics(FUTURE + 13 * H, FUTURE + 14 * H, 1));
		assert.equal(sqlite.prepare("SELECT starts_at FROM calendar_events WHERE id = ?").get(id).starts_at, Math.floor((FUTURE + 13 * H) / 1000), "the event moved");
		assert.deepEqual(rooms(), expected);
	});

	test(`MCP update, ${label}`, async () => {
		setup(team);
		sqlite.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, time_zone, created_at, updated_at) VALUES ('e1', 'u1', 't', ?, ?, 'UTC', 1, 1)").run(Math.floor((FUTURE + 9 * H) / 1000), Math.floor((FUTURE + 10 * H) / 1000));
		book("e1");
		const context = { env: {}, user: { id: "u1", calendarEnabled: true, timeZone: "UTC" }, confirmed: true, timeZone: "UTC" };
		await runCalendarTool(context, "update_events", { updates: [{ eventId: "e1", startsAt: new Date(FUTURE + 13 * H).toISOString(), endsAt: new Date(FUTURE + 14 * H).toISOString() }] });
		assert.deepEqual(rooms(), expected);
	});

	test(`time-zone change, ${label}`, async () => {
		setup(team);
		sqlite.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, repeat, created_at, updated_at) VALUES ('e1', 'u1', 't', ?, ?, 'weekly', 1, 1)").run(Math.floor((FUTURE + 9 * H) / 1000), Math.floor((FUTURE + 10 * H) / 1000));
		book("e1");
		const response = await changeZone(new Request("https://m.test/api/settings/time-zone", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ timeZone: "Asia/Tokyo" }) }));
		assert.equal(response.status, 200);
		assert.deepEqual(rooms(), expected);
	});
}

test("a licence check that fails never accepts anything: the rooms end declined", async () => {
	setup(true);
	sqlite.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, time_zone, created_at, updated_at) VALUES ('e1', 'u1', 't', ?, ?, 'UTC', 1, 1)").run(Math.floor((FUTURE + 9 * H) / 1000), Math.floor((FUTURE + 10 * H) / 1000));
	book("e1");
	Object.defineProperty(globalThis.roomLx, "team", { get() { throw new Error("licence service down"); }, configurable: true });
	const context = { env: {}, user: { id: "u1", calendarEnabled: true, timeZone: "UTC" }, confirmed: true, timeZone: "UTC" };
	await runCalendarTool(context, "update_events", { updates: [{ eventId: "e1", startsAt: new Date(FUTURE + 13 * H).toISOString(), endsAt: new Date(FUTURE + 14 * H).toISOString() }] });
	assert.deepEqual(rooms(), [["r1", "declined"], ["r2", "declined"]]);
});

test("a booking that an interrupted write left waiting for its re-check (declined with the epoch as its date) was accepted before, so a lapsed licence may still re-check it", async () => {
	setup(false);
	sqlite.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, time_zone, created_at, updated_at) VALUES ('e1', 'u1', 't', ?, ?, 'UTC', 1, 1)").run(Math.floor((FUTURE + 9 * H) / 1000), Math.floor((FUTURE + 10 * H) / 1000));
	sqlite.exec("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, conflict_at, created_at) VALUES ('b1', 'r1', 'e1', 'declined', 0, 1), ('b2', 'r2', 'e1', 'declined', 86400, 1)");
	const shown = await roomsByEvent(globalThis.roomLx.db, ["e1"]);
	assert.deepEqual(shown.get("e1").map((room) => room.conflictAt), [null, "1970-01-02T00:00:00.000Z"], "the epoch is a marker, never shown as a clash date");
	const context = { env: {}, user: { id: "u1", calendarEnabled: true, timeZone: "UTC" }, confirmed: true, timeZone: "UTC" };
	await runCalendarTool(context, "update_events", { updates: [{ eventId: "e1", title: "Renamed" }] });
	assert.deepEqual(rooms(), [["r1", "accepted"], ["r2", "declined"]], "r1 was waiting for its check; r2 really clashed and stays declined");
});
