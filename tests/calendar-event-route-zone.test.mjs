import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-calendar-route-zone-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
// The first select().from().where().limit() is the PATCH's `existing` lookup; every later select is empty. Writes are no-ops.
const mocks = {
	"next/server": "export const NextResponse = { json: (body, init) => Response.json(body, init) }",
	"drizzle-orm": "export const eq=()=>({}), and=()=>({})",
	"@/db/schema": "export const calendarEvents={}, calendarEventOverrides={}",
	"@/lib/cloudflare": "export const getEnv=()=>({})",
	"@/lib/calendar/api-auth": "export async function authorizeCalendarRequest(){return {user:{id:'u1'},key:null,error:null}}; export const calendarKeyCanSendInvitations=()=>true",
	"@/lib/email/send": "export async function sendEmail(env,message){globalThis.__sent.push(new TextDecoder().decode(message.attachments[0].content))}",
	"@/db": "export const getDb=()=>({select:()=>({from:()=>({where:()=>({limit:async()=>globalThis.__first++?[]:[globalThis.__existing],then:(resolve)=>resolve([])})})}),insert:()=>({values:async()=>{}}),update:()=>({set:()=>({where:async()=>{}})}),delete:()=>({where:async()=>{}})})",
};
const names = Object.keys(mocks).map((name) => name.replace(/[/.-]/g, "\\$&")).join("|");
await build({
	entryPoints: [join(root, "src/app/api/calendar/events/[eventId]/route.ts")], outfile: join(outDir, "route.mjs"), bundle: true, platform: "node", format: "esm", packages: "external", alias: { "@": join(root, "src") }, logLevel: "silent",
	plugins: [{ name: "mock-deps", setup(builder) {
		builder.onResolve({ filter: new RegExp(`^(${names})$`) }, (args) => ({ path: args.path, namespace: "mock" }));
		builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
	} }],
});
const { PATCH } = await import(pathToFileURL(join(outDir, "route.mjs")).href);

const existingRow = () => ({
	id: "evt_1", userId: "u1", mailboxId: "mb1", title: "Sync", description: "", location: "", attendees: "[]", color: "blue",
	repeat: "weekly", repeatDays: "[]", repeatAnchorDay: null, repeatUntil: null, repeatInterval: 1, repeatWeekday: null, repeatWeek: null,
	excludedOccurrences: "[]", startsAt: new Date("2026-11-08T23:00:00Z"), endsAt: new Date("2026-11-08T23:30:00Z"),
	timeZone: "Asia/Tokyo", eventSequence: 0, reminderMinutes: null, responseStatus: null, inviteMessageId: null,
});
async function patch(id, body) {
	globalThis.__existing = existingRow();
	globalThis.__first = 0;
	globalThis.__sent = [];
	const response = await PATCH(new Request(`http://localhost/api/calendar/events/${id}`, { method: "PATCH", body: JSON.stringify({ title: "Sync", attendees: ["g@example.com"], from: "me@example.com", ...body }) }), { params: Promise.resolve({ eventId: id }) });
	assert.equal(response.status, 200);
	return globalThis.__sent;
}
const fileFor = (sent, uid) => sent.find((text) => text.includes(`UID:${uid}@mailflare`));

test("a split sends the truncation in the stored zone and the fork in the new zone", async () => {
	const sent = await patch("evt_1", { startsAt: "2026-11-23T14:00:00Z", endsAt: "2026-11-23T14:30:00Z", effectiveFrom: "2026-11-16T23:00:00Z", timeZone: "America/New_York" });
	assert.equal(sent.length, 2);
	const truncation = fileFor(sent, "evt_1");
	const fork = sent.find((text) => text !== truncation);
	assert.match(truncation, /DTSTART;TZID=Asia\/Tokyo:20261109T080000/);
	assert.doesNotMatch(truncation, /America\/New_York/);
	assert.match(fork, /DTSTART;TZID=America\/New_York:20261123T090000/);
	assert.doesNotMatch(fork, /Asia\/Tokyo/);
});

test("a full update carries the event zone", async () => {
	const sent = await patch("evt_1", { startsAt: "2026-11-08T23:00:00Z", endsAt: "2026-11-08T23:30:00Z", timeZone: "America/New_York" });
	assert.equal(sent.length, 1);
	assert.match(sent[0], /DTSTART;TZID=America\/New_York:20261108T180000/);
});

test("moving an occurrence to the past keeps the series in its stored zone", async () => {
	const occurrence = Date.parse("2026-11-15T23:00:00Z");
	const sent = await patch(`evt_1@${occurrence}`, { startsAt: "2026-11-17T01:00:00Z", endsAt: "2026-11-17T01:30:00Z", moveOccurrenceToPast: true, timeZone: "America/New_York" });
	const series = fileFor(sent, "evt_1");
	assert.match(series, /DTSTART;TZID=Asia\/Tokyo:20261109T080000/);
	assert.match(series, /EXDATE;TZID=Asia\/Tokyo:20261116T080000/);
});
