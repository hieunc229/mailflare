import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

const mocks = {
	"@/lib/cloudflare": "export function getEnv(){return globalThis.limEnv}",
	"@/lib/calendar/api-auth": 'export async function authorizeCalendarRequest(){return {user:{id:"admin",timeZone:"UTC"},key:null,error:null}} export function calendarKeyCanSendInvitations(){return true}',
	"@/lib/email/send": "export async function sendEmail(env,input){ globalThis.limSent.push(input.to) }",
	"@/lib/deliverability/suppression": "export async function assertInviteesAllowed(){ globalThis.limChecked += 1 }",
};
const { app, newDatabase } = await loadApp("calendar-event-limits", `
	export * as list from "./src/app/api/calendar/events/route.ts";
	export * as item from "./src/app/api/calendar/events/[eventId]/route.ts";
`, { mocks });

async function setup(t) {
	const { env, sqlite } = await newDatabase(t, sharedMailboxSeed("full_access"));
	sqlite.prepare("INSERT INTO calendar_events (id, user_id, mailbox_id, title, attendees, starts_at, ends_at, created_at, updated_at) VALUES ('evt1','admin','mb-admin','Sync','[]',1800000000,1800003600,1,1)").run();
	globalThis.limEnv = env;
	globalThis.limSent = [];
	globalThis.limChecked = 0;
	return sqlite;
}
const get = (query) => app.list.GET(new Request(`http://localhost/api/calendar/events?${query}`));
const body = (attendees) => ({ title: "T", startsAt: "2027-01-01T10:00:00Z", endsAt: "2027-01-01T11:00:00Z", mailboxId: "mb-admin", from: "admin@example.com", attendees });
const guests = (n) => Array.from({ length: n }, (_, i) => `g${i}@x.test`);
const post = (attendees) => app.list.POST(new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body(attendees)) }));
const patch = (attendees) => app.item.PATCH(new Request("http://localhost/x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body(attendees)) }), { params: Promise.resolve({ eventId: "evt1" }) });

test("GET answers 400 for an unparseable start or end", async (t) => {
	await setup(t);
	assert.equal((await get("start=garbage")).status, 400);
	assert.equal((await get("start=2026-01-01&end=nope")).status, 400);
});

test("GET accepts 59 days and refuses more than 400", async (t) => {
	await setup(t);
	assert.equal((await get("start=2026-01-01&end=2026-03-01")).status, 200);
	assert.equal((await get("start=2026-01-01&end=2027-06-01")).status, 400);
});

test("POST refuses 51 attendees before any check or send, accepts 50", async (t) => {
	await setup(t);
	const refused = await post(guests(51));
	assert.equal(refused.status, 400);
	assert.equal(globalThis.limChecked, 0);
	assert.deepEqual(globalThis.limSent, []);
	assert.equal((await post(guests(50))).status, 200);
	assert.equal(globalThis.limSent.length, 50);
});

test("PATCH refuses 51 attendees before any send", async (t) => {
	await setup(t);
	assert.equal((await patch(guests(51))).status, 400);
	assert.deepEqual(globalThis.limSent, []);
});
