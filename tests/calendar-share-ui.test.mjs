import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadFixture } from "./helpers/fixtures.mjs";

const en = JSON.parse(readFileSync(new URL("../src/lib/i18n/en.json", import.meta.url), "utf8"));
globalThis.calShareUi = { en, calls: [], reply: () => new Response("{}") };
const mocks = {
	"./calendar-state": "export const useCalendarState=()=>globalThis.calShareUi.state; export const toggleCalendar=()=>{}; export const openCalendarSettings=()=>{}; export const retryCalendars=()=>{};",
	"@/components/language-provider": "export function useLanguage(){return {t:(key,values={})=>(globalThis.calShareUi.en[key]??key).replace(/\\{(\\w+)\\}/g,(m,n)=>values[n]??m)}}",
	"@/lib/auth/client": "export async function authFetch(url,init){globalThis.calShareUi.calls.push([url,init]);return globalThis.calShareUi.reply(url,init)}",
};
const fixtures = {
	list: await loadFixture({ name: "cal-share-ui-list", entryPoint: "src/app/(calendar)/calendar/calendar-list.tsx", mocks }),
	view: await loadFixture({ name: "cal-share-ui-view", entryPoint: "src/app/(calendar)/calendar/calendar-share-view.tsx", mocks }),
	api: await loadFixture({ name: "cal-share-ui-api", entryPoint: "src/app/(calendar)/calendar/calendar-share-api.ts", mocks }),
	utils: await loadFixture({ name: "cal-share-ui-utils", entryPoint: "src/app/(calendar)/calendar/calendar-list-utils.ts", mocks }),
	eventView: await loadFixture({ name: "cal-share-ui-event", entryPoint: "src/app/(calendar)/calendar/event-view-dialog.tsx", mocks: { ...mocks, "./utils": "export const formatEventRange=()=>'Tue 10:00 - 11:00'" } }),
};
const { CalendarList } = await fixtures.list.import();
const { ShareView } = await fixtures.view.import();
const api = await fixtures.api.import();
const { calendarLabel, eventErrorKey, writableCalendars, canManageCalendar, canWriteEvents, shareErrorKey, calendarErrorKey } = await fixtures.utils.import();
const { EventDetails } = await fixtures.eventView.import();
after(() => { delete globalThis.calShareUi; for (const fixture of Object.values(fixtures)) fixture.dispose(); });

const own = { id: "cal:u1", name: null, color: "#2563eb", description: "", isDefault: true, role: "owner" };
const work = { id: "cal:work", name: "Work", color: "#7c3aed", description: "", isDefault: false, role: "owner" };
const sharedDefault = { id: "cal:u2", name: null, color: "#16a34a", description: "", isDefault: false, role: "edit", ownerName: "Sam", ownerId: "u2" };
const sharedManaged = { id: "cal:ops", name: "On-call", color: "#dc2626", description: "", isDefault: false, role: "manage", ownerName: "Sam", ownerId: "u2" };
const sharedRead = { id: "cal:hol", name: "Holidays", color: "#0891b2", description: "", isDefault: false, role: "read", ownerName: "Pat", ownerId: "u3" };
const renderList = (calendars, hidden = []) => { globalThis.calShareUi.state = { calendars, state: "ready", hidden, settings: null, revision: 0 }; return renderToStaticMarkup(createElement(CalendarList)); };

test("the sidebar lists shared calendars under their own heading, with owner and role; nothing extra when none is shared", () => {
	const html = renderList([own, work, sharedDefault, sharedManaged, sharedRead]);
	assert.match(html, /Shared with me/);
	assert.match(html, /aria-label="Show Sam&#x27;s calendar"/);
	assert.match(html, /aria-label="Show On-call"/);
	assert.match(html, /Shared by Pat/);
	assert.match(html, /Can edit/);
	assert.match(html, /View only/);
	assert.match(html, /Can manage/);
	assert.doesNotMatch(renderList([own, work]), /Shared with me/);
});

test("only the owner and a manager get a settings button; an editor or reader can only show or hide the calendar", () => {
	const html = renderList([own, sharedDefault, sharedManaged, sharedRead]);
	assert.match(html, /aria-label="Settings for On-call"/);
	assert.doesNotMatch(html, /aria-label="Settings for Holidays"/);
	assert.doesNotMatch(html, /aria-label="Settings for Sam/);
	assert.match(html, /aria-label="Settings for My calendar"/);
});

test("a hidden shared calendar is unchecked like any other, and every shared control has a 44px coarse target", () => {
	const html = renderList([own, sharedRead], ["cal:hol"]);
	assert.doesNotMatch(html.match(/<input[^>]*Show Holidays[^>]*>/)[0], /checked/);
	assert.ok((html.match(/min-h-11/g) ?? []).length >= 4);
});

test("calendarLabel: own name, localised default, or the owner's name for someone else's unnamed default", () => {
	const t = (key, values = {}) => en[key].replace(/\{(\w+)\}/g, (m, n) => values[n] ?? m);
	assert.equal(calendarLabel(own, t), "My calendar");
	assert.equal(calendarLabel(work, t), "Work");
	assert.equal(calendarLabel(sharedDefault, t), "Sam's calendar");
});

test("the editor offers writable calendars; an existing event stays with its owner", () => {
	const all = [own, work, sharedDefault, sharedManaged, sharedRead, { ...sharedRead, id: "cal:other", role: "edit", ownerId: "u9" }];
	assert.deepEqual(writableCalendars(all, null).map((c) => c.id), ["cal:u1", "cal:work", "cal:u2", "cal:ops", "cal:other"]);
	assert.deepEqual(writableCalendars(all, { role: "owner", calendarId: "cal:work" }).map((c) => c.id), ["cal:u1", "cal:work"]);
	assert.deepEqual(writableCalendars(all, { role: "edit", calendarId: "cal:ops" }).map((c) => c.id), ["cal:u2", "cal:ops"]);
	assert.deepEqual([canWriteEvents("read"), canWriteEvents("edit"), canWriteEvents("owner"), canWriteEvents(undefined)], [false, true, true, true]);
	assert.deepEqual([canManageCalendar("manage"), canManageCalendar("edit"), canManageCalendar("owner")], [true, false, true]);
});

test("a duplicate share and the people limit read differently; an event write refused after a revoke is a translated message", () => {
	assert.equal(shareErrorKey(409, "ALREADY_SHARED"), "calendar.share.error.exists");
	assert.equal(shareErrorKey(409, "SHARE_LIMIT"), "calendar.share.error.limit");
	assert.equal(eventErrorKey(403, "INVITE_REQUIRES_OWNER"), "calendar.share.inviteRefused");
	assert.equal(eventErrorKey(403), "calendar.share.error.eventDenied");
	assert.equal(eventErrorKey(404), "calendar.share.error.eventDenied");
	assert.equal(eventErrorKey(400), null);
	for (const key of ["exists", "limit", "eventDenied"]) assert.ok(en[`calendar.share.error.${key}`], key);
});

test("sharing errors map to translated messages by status", () => {
	for (const [status, key] of [[404, "notFound"], [400, "invalid"], [409, "conflict"], [403, "denied"], [500, "generic"], [0, "generic"]]) {
		assert.equal(shareErrorKey(status), `calendar.share.error.${key}`);
		assert.ok(en[`calendar.share.error.${key}`], key);
	}
	assert.equal(calendarErrorKey("save", 403), "calendar.calendars.error.denied");
	assert.ok(en["calendar.calendars.error.denied"]);
});

const person = (id, role) => ({ id, userId: `user-${id}`, name: `Person ${id}`, email: `${id}@one.test`, role, createdAt: "2026-11-26T00:00:00.000Z" });
const noop = () => {};
const view = (props = {}) => renderToStaticMarkup(createElement(ShareView, { state: "ready", shares: [], pendingId: null, email: "", role: "read", adding: false, error: "", onEmail: noop, onRole: noop, onAdd: noop, onChangeRole: noop, onRemove: noop, onRetry: noop, ...props }));

test("share view, loading: a status line and no list or form errors", () => {
	const html = view({ state: "loading" });
	assert.match(html, /role="status"/);
	assert.doesNotMatch(html, /<ul/);
});

test("share view, error: an alert with a retry button", () => {
	const html = view({ state: "error" });
	assert.match(html, /role="alert"/);
	assert.match(html, /Try again/);
});

test("share view, empty: says so, and the form is still there", () => {
	const html = view();
	assert.match(html, /Not shared with anyone yet/);
	assert.match(html, /aria-label="Email address"/);
	assert.match(html, /type="email"/);
	assert.match(html, /<button[^>]*type="submit"[^>]*disabled=""/, "nothing to share until an address is typed");
});

test("share view, ready: one row per person with a labelled permission control and a remove button", () => {
	const html = view({ shares: [person("a", "edit"), person("b", "freebusy")] });
	assert.match(html, /Person a/);
	assert.match(html, /a@one\.test/);
	assert.match(html, /aria-label="Permission for Person a"/);
	assert.match(html, /aria-label="Stop sharing with Person b"/);
	assert.doesNotMatch(html, /Not shared with anyone yet/);
});

test("share view: a typed address enables Share; pending and error states are announced; the row being changed is disabled", () => {
	assert.doesNotMatch(view({ email: "x@one.test" }).match(/<button[^>]*type="submit"[^>]*>/)[0], /disabled=""/);
	assert.match(view({ email: "x@one.test", adding: true }).match(/<button[^>]*type="submit"[^>]*>/)[0], /disabled=""/);
	assert.match(view({ error: "No account on this server uses that address." }), /role="alert"[^>]*>No account on this server/);
	const busy = view({ shares: [person("a", "edit")], pendingId: "a" });
	assert.match(busy.match(/<button[^>]*Stop sharing with Person a[^>]*>/)[0], /disabled=""/);
	assert.match(busy, /aria-busy="true"/);
});

test("share view: coarse pointers get 44px targets", () => {
	assert.ok((view({ shares: [person("a", "edit")] }).match(/min-h-11/g) ?? []).length >= 3);
});

test("the share api sends the grant to the right route and reports statuses", async () => {
	const calls = globalThis.calShareUi.calls;
	calls.length = 0;
	globalThis.calShareUi.reply = () => Response.json({ shares: [person("a", "read")] });
	const loaded = await api.loadShares("cal:work");
	assert.deepEqual([loaded.ok, loaded.shares.length], [true, 1]);
	assert.equal(calls[0][0], "/api/calendar/calendars/cal%3Awork/shares");
	globalThis.calShareUi.reply = () => Response.json({ share: person("n", "edit") });
	const added = await api.addShare("cal:work", "n@one.test", "edit");
	assert.deepEqual([calls[1][1].method, JSON.parse(calls[1][1].body)], ["POST", { email: "n@one.test", role: "edit" }]);
	assert.equal(added.share.id, "n");
	await api.changeShareRole("cal:work", "n", "read");
	assert.deepEqual([calls[2][1].method, JSON.parse(calls[2][1].body)], ["PATCH", { id: "n", role: "read" }]);
	await api.removeShare("cal:work", "n");
	assert.deepEqual([calls[3][1].method, JSON.parse(calls[3][1].body)], ["DELETE", { id: "n" }]);
	globalThis.calShareUi.reply = () => Response.json({ error: "x" }, { status: 409 });
	assert.deepEqual(await api.addShare("cal:work", "n@one.test", "edit"), { ok: false, status: 409, code: undefined });
	globalThis.calShareUi.reply = () => Response.json({ error: "x", code: "SHARE_LIMIT" }, { status: 409 });
	assert.deepEqual(await api.addShare("cal:work", "n@one.test", "edit"), { ok: false, status: 409, code: "SHARE_LIMIT" });
	globalThis.calShareUi.reply = () => { throw new Error("offline"); };
	assert.deepEqual(await api.loadShares("cal:work"), { ok: false, status: 0 });
});

test("the read-only event dialog shows what the viewer may see, names the calendar, and says it cannot be changed", () => {
	const event = { id: "e", title: "Busy", description: "", location: "", startsAt: "2026-12-01T10:00:00Z", endsAt: "2026-12-01T11:00:00Z", redacted: true, role: "read" };
	const html = renderToStaticMarkup(createElement(EventDetails, { event: { ...event, title: "Standup", redacted: false, location: "Room 4" }, calendarName: "Holidays" }));
	assert.match(html, /Room 4/);
	assert.match(html, /Holidays/);
	assert.match(html, /You can view this event but not change it/);
});
