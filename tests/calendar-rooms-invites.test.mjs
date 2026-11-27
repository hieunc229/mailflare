import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

// I-2: an updated invitation can move an event that has rooms; it is declined in the same batch and checked again.
const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const mocks = { "@/db": "export function getDb(){return globalThis.roomInv.db}" };
const fixture = await loadFixture({ name: "room-inv", entryPoint: "src/lib/calendar/invite-store.ts", mocks });
const { registerInboundInvite, inviteEventId } = await fixture.import();
let sqlite;
let dead = false;
after(() => { sqlite?.close(); delete globalThis.roomInv; fixture.dispose(); });

const FUTURE = Date.UTC(new Date().getUTCFullYear() + 1, 2, 4);
const H = 3_600_000;
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const ics = (start, end, sequence = 0, method = "REQUEST", extra = "") => ["BEGIN:VCALENDAR", "VERSION:2.0", `METHOD:${method}`, "BEGIN:VEVENT", "UID:meeting-1@host.test", `SEQUENCE:${sequence}`, `DTSTAMP:${stamp(FUTURE)}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`, "SUMMARY:Review", "ORGANIZER:mailto:boss@host.test", extra, "END:VEVENT", "END:VCALENDAR"].filter(Boolean).join("\r\n");
const receive = (body) => registerInboundInvite({}, { userId: "u1", mailboxId: "m1", messageId: "msg", senderAddress: "boss@host.test", attachments: [{ filename: "invite.ics", type: "text/calendar", content: new TextEncoder().encode(body).buffer }] });

async function setup() {
	sqlite?.close();
	dead = false;
	sqlite = installSqlite("roomInv", { schema, beforeQuery: () => { if (dead) throw new Error("process died"); } });
	globalThis.roomInv.db.batch = async (list) => { sqlite.exec("BEGIN"); try { for (const statement of list) await statement; sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; } dead = globalThis.roomInv.dieAfterBatch === true; };
	globalThis.roomInv.dieAfterBatch = false;
	sqlite.exec("INSERT INTO users (id, email, name, password_hash, role, time_zone, created_at) VALUES ('u1', 'u1@one.test', 'U', 'x', 'user', 'UTC', 1)");
	sqlite.exec("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'one.test', 'z', 1)");
	sqlite.exec("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('m1', 'u1', 'd1', 'u1', 1)");
	sqlite.exec("INSERT INTO calendar_resources (id, name, created_at, updated_at) VALUES ('r1', 'Room', 1, 1)");
	await receive(ics(FUTURE + 9 * H, FUTURE + 10 * H));
	const id = await inviteEventId("u1", "meeting-1@host.test");
	sqlite.prepare("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES ('b1', 'r1', ?, 'accepted', 1)").run(id);
	return id;
}
const status = (id) => sqlite.prepare("SELECT status FROM calendar_resource_bookings WHERE event_id = ?").get(id)?.status;

test("an updated invitation that moves a booked event declines the booking in its own batch, so a stop before the room step leaves none accepted", async () => {
	const id = await setup();
	globalThis.roomInv.dieAfterBatch = true;
	await receive(ics(FUTURE + 13 * H, FUTURE + 14 * H, 1));
	assert.equal(sqlite.prepare("SELECT starts_at FROM calendar_events WHERE id = ?").get(id).starts_at, Math.floor((FUTURE + 13 * H) / 1000), "the event moved");
	assert.equal(status(id), "declined");
});

test("the room step then checks the move: a free slot is booked again, a taken one stays declined", async () => {
	const id = await setup();
	await receive(ics(FUTURE + 13 * H, FUTURE + 14 * H, 1));
	assert.equal(status(id), "accepted", "free at the new time");
	const other = "other-event";
	sqlite.prepare("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at) VALUES (?, 'u1', 't', ?, ?, 1, 1)").run(other, Math.floor((FUTURE + 15 * H) / 1000), Math.floor((FUTURE + 16 * H) / 1000));
	sqlite.prepare("INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) VALUES ('b2', 'r1', ?, 'accepted', 1)").run(other);
	await receive(ics(FUTURE + 15 * H, FUTURE + 16 * H, 2));
	assert.equal(status(id), "declined", "moved onto the other booking");
});

test("an invitation for an event with no rooms is registered as before", async () => {
	const id = await setup();
	sqlite.exec("DELETE FROM calendar_resource_bookings");
	await receive(ics(FUTURE + 13 * H, FUTURE + 14 * H, 1));
	assert.equal(sqlite.prepare("SELECT starts_at FROM calendar_events WHERE id = ?").get(id).starts_at, Math.floor((FUTURE + 13 * H) / 1000));
});

test("an occurrence cancelled by the organiser re-checks the series' rooms too", async () => {
	const id = await setup();
	sqlite.prepare("UPDATE calendar_events SET repeat = 'weekly' WHERE id = ?").run(id);
	globalThis.roomInv.dieAfterBatch = true;
	await receive(ics(FUTURE + 7 * 24 * H + 9 * H, FUTURE + 7 * 24 * H + 10 * H, 1, "CANCEL", `RECURRENCE-ID:${stamp(FUTURE + 7 * 24 * H + 9 * H)}`));
	assert.equal(status(id), "declined");
});

test("answering an invitation from the message page re-checks the rooms the same way (wired in the route)", () => {
	const route = readFileSync(new URL("../src/app/api/messages/[messageId]/invite/route.ts", import.meta.url), "utf8");
	assert.equal([...route.matchAll(/declineBookingsStatement\(db, id\)/g)].length, 2, "the exclude and the update paths");
	assert.equal([...route.matchAll(/rebookEvents\(db, \[id\], roomsBookable\(env\)\)/g)].length, 2);
});
