import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadComponent } from "./helpers/dom-component.mjs";

const { parseAttendees } = await loadComponent("src/app/(calendar)/calendar/utils.ts");

test("parseAttendees tolerates bad stored values", () => {
	assert.deepEqual(parseAttendees('["a@x.test","b@x.test"]'), ["a@x.test", "b@x.test"]);
	for (const raw of ["", null, undefined, "not json", "{}", "null"]) assert.deepEqual(parseAttendees(raw), [], String(raw));
	assert.deepEqual(parseAttendees('[1,"a@x.test"]'), ["a@x.test"]);
});

test("the month picker is a focus-managed dialog", () => {
	const source = readFileSync(new URL("../src/app/(calendar)/calendar/page.tsx", import.meta.url), "utf8");
	assert.match(source, /<DialogFrame label=\{t\("calendar\.chooseDate"\)\}/);
});

test("resize handles are not tab stops and are hidden from assistive tech", async () => {
	const { DayEvents } = await loadComponent("src/app/(calendar)/calendar/day-events.tsx", {
		"@/components/language-provider": "export function useLanguage() { return { t: (key) => key }; }",
	});
	const noop = () => {};
	const event = {
		id: "e1", title: "Standup", description: "", location: "", attendees: "[]", color: "blue", repeat: "none", repeatDays: "[]",
		repeatAnchorDay: null, repeatUntil: null, excludedOccurrences: "[]", timeZone: null,
		startsAt: new Date(2026, 5, 3, 10).toISOString(), endsAt: new Date(2026, 5, 3, 11).toISOString(),
	};
	const html = renderToStaticMarkup(createElement(DayEvents, {
		day: new Date(2026, 5, 3), events: [event], currentTime: 0, busy: false, activeEventId: null,
		onEdit: noop, onDragStart: noop, onDragEnd: noop, onResizeStart: noop, onResizeMove: noop, onResizeEnd: noop, onResizeCancel: noop,
	}));
	const buttons = html.match(/<button[^>]*>/g) ?? [];
	const handles = buttons.filter((tag) => tag.includes("cursor-ns-resize"));
	assert.ok(handles.length >= 1);
	for (const tag of handles) { assert.match(tag, /tabindex="-1"/); assert.match(tag, /aria-hidden="true"/); }
	const main = buttons.find((tag) => tag.includes('title="Standup'));
	assert.ok(main && !/tabindex|aria-hidden/.test(main));
});
