import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

const mocks = {
	"@/lib/cloudflare": "export function getEnv(){return globalThis.calEnv}",
	"@/lib/calendar/api-auth": "export async function authorizeCalendarRequest(){return {user:{id:\"admin\"},key:null,error:null}} export function calendarKeyCanSendInvitations(){return true}",
	"@/lib/email/send": "export async function sendEmail(env,input){ if(input.to===\"bad@example.com\") throw new Error(\"suppressed\"); globalThis.calSent.push(input.to) }",
};
const { app, newDatabase } = await loadApp("calendar-event-delete", 'export * as route from "./src/app/api/calendar/events/[eventId]/route.ts";', { mocks });

async function run(t, attendees) {
	const { env, sqlite } = await newDatabase(t, sharedMailboxSeed("full_access"));
	sqlite.prepare("INSERT INTO calendar_events (id, user_id, mailbox_id, title, attendees, starts_at, ends_at, created_at, updated_at) VALUES ('evt1','admin','mb-admin','Sync',?,1800000000,1800003600,1,1)").run(JSON.stringify(attendees));
	globalThis.calEnv = env;
	globalThis.calSent = [];
	const res = await app.route.DELETE(new Request("http://localhost/x", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "admin@example.com" }) }), { params: Promise.resolve({ eventId: "evt1" }) });
	return { res, rows: sqlite.prepare("SELECT id FROM calendar_events").all() };
}

test("delete reports a refused cancellation instead of failing", async (t) => {
	const { res, rows } = await run(t, ["good@example.com", "bad@example.com"]);
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { ok: true, inviteErrors: ["bad@example.com"] });
	assert.deepEqual(globalThis.calSent, ["good@example.com"]);
	assert.equal(rows.length, 0);
});

test("delete with all cancellations accepted answers plain ok", async (t) => {
	const { res } = await run(t, ["good@example.com"]);
	assert.deepEqual(await res.json(), { ok: true });
});
