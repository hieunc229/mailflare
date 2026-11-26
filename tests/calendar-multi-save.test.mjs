import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { loadFixture } from "./helpers/fixtures.mjs";

globalThis.calSave = { calls: [], status: 200 };
const fixture = await loadFixture({
	name: "calendar-multi-save",
	entryPoint: "src/app/(calendar)/calendar/calendar-save.ts",
	mocks: { "@/lib/auth/client": "export async function authFetch(url,init){const s=globalThis.calSave;s.calls.push({url,init});return Response.json({calendar:{id:'cal:work'}},{status:s.status})}" },
});
const { saveCalendar } = await fixture.import();
after(() => { delete globalThis.calSave; fixture.dispose(); });
beforeEach(() => { globalThis.calSave.calls = []; globalThis.calSave.status = 200; });

// A calendar a phone coloured outside the palette: the dialog shows the nearest palette colour, which it must not write back.
const work = { id: "cal:work", name: "Work", color: "#2563eb", description: "Team", isDefault: false, role: "owner", eventCount: 2 };
const body = () => JSON.parse(globalThis.calSave.calls[0].init.body);

test("renaming sends only the name", async () => {
	const result = await saveCalendar(work, { name: " Team ", color: "#2563eb", description: "Team" });
	assert.equal(result.ok, true);
	assert.deepEqual(body(), { name: "Team" });
	assert.equal(globalThis.calSave.calls[0].init.method, "PATCH");
	assert.equal(globalThis.calSave.calls[0].url, "/api/calendar/calendars/cal%3Awork");
});

test("a changed colour or description is sent on its own", async () => {
	await saveCalendar(work, { name: "Work", color: "#16a34a", description: "Team" });
	assert.deepEqual(body(), { color: "#16a34a" });
	globalThis.calSave.calls = [];
	await saveCalendar(work, { name: "Work", color: "#2563eb", description: "" });
	assert.deepEqual(body(), { description: "" });
});

test("saving with nothing changed sends nothing", async () => {
	const result = await saveCalendar(work, { name: "Work", color: "#2563eb", description: "Team" });
	assert.deepEqual([result.ok, result.unchanged, globalThis.calSave.calls.length], [true, true, 0]);
});

test("an unnamed default calendar with an empty name sends no name", async () => {
	const home = { ...work, id: "cal:u1", name: null, isDefault: true };
	await saveCalendar(home, { name: "", color: "#16a34a", description: "Team" });
	assert.deepEqual(body(), { color: "#16a34a" });
});

test("a new calendar sends everything with POST", async () => {
	await saveCalendar(null, { name: "Holidays", color: "#dc2626", description: "" });
	assert.deepEqual(body(), { name: "Holidays", color: "#dc2626", description: "" });
	assert.equal(globalThis.calSave.calls[0].init.method, "POST");
	assert.equal(globalThis.calSave.calls[0].url, "/api/calendar/calendars");
});

test("a failed save reports the status, not the server's text", async () => {
	globalThis.calSave.status = 409;
	assert.deepEqual(await saveCalendar(null, { name: "A", color: "#dc2626", description: "" }), { ok: false, status: 409 });
});
