import assert from "node:assert/strict";
import test from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { layoutOverlappingEvents, DayEvents } = await loadComponent("src/app/(calendar)/calendar/day-events.tsx", {
	"@/components/language-provider": "export function useLanguage() { return { t: (key) => key }; }",
});

const block = (id, startHour, endHour) => ({ id, top: startHour * 60, height: (endHour - startHour) * 60 });
const slots = (blocks) => Object.fromEntries([...layoutOverlappingEvents(blocks)].map(([id, slot]) => [id, slot]));

test("a lone block is full width", () => {
	assert.deepEqual(slots([block("a", 10, 11)]), { a: { column: 0, columns: 1 } });
});

test("partial overlap makes two columns", () => {
	assert.deepEqual(slots([block("a", 10, 11), block("b", 10.5, 11.5)]), { a: { column: 0, columns: 2 }, b: { column: 1, columns: 2 } });
});

test("identical blocks split", () => {
	assert.deepEqual(slots([block("a", 10, 11), block("b", 10, 11)]), { a: { column: 0, columns: 2 }, b: { column: 1, columns: 2 } });
});

test("touching blocks do not overlap", () => {
	assert.deepEqual(slots([block("a", 10, 11), block("b", 11, 12)]), { a: { column: 0, columns: 1 }, b: { column: 0, columns: 1 } });
});

test("a long block next to two short ones", () => {
	assert.deepEqual(slots([block("a", 9, 12), block("b", 9.5, 10), block("c", 10.5, 11)]), { a: { column: 0, columns: 2 }, b: { column: 1, columns: 2 }, c: { column: 1, columns: 2 } });
});

test("a chain forms one cluster", () => {
	assert.deepEqual(slots([block("a", 9, 10.5), block("b", 10, 11.5), block("c", 11, 12)]), { a: { column: 0, columns: 2 }, b: { column: 1, columns: 2 }, c: { column: 0, columns: 2 } });
});

test("separate clusters have separate widths", () => {
	const result = slots([block("a", 9, 10), block("b", 9, 10), block("c", 9, 10), block("d", 14, 15)]);
	assert.equal(result.a.columns, 3);
	assert.deepEqual(result.d, { column: 0, columns: 1 });
});

test("the result has an entry for every input id", () => {
	const input = [block("x", 1, 2), block("y", 1, 3), block("z", 5, 6)];
	assert.deepEqual([...layoutOverlappingEvents(input).keys()].sort(), ["x", "y", "z"]);
});

const calendarEvent = (id, startHour, endHour) => ({
	id, title: id, description: "", location: "", attendees: "[]", color: "blue", repeat: "none", repeatDays: "[]",
	repeatAnchorDay: null, repeatUntil: null, excludedOccurrences: "[]", timeZone: null,
	startsAt: new Date(2026, 5, 3, Math.floor(startHour), (startHour % 1) * 60).toISOString(),
	endsAt: new Date(2026, 5, 3, Math.floor(endHour), (endHour % 1) * 60).toISOString(),
});
const render = (events) => {
	const noop = () => {};
	return renderToStaticMarkup(createElement(DayEvents, {
		day: new Date(2026, 5, 3), events, currentTime: 0, busy: false, activeEventId: null,
		onEdit: noop, onDragStart: noop, onDragEnd: noop, onResizeStart: noop, onResizeMove: noop, onResizeEnd: noop, onResizeCancel: noop,
	}));
};

test("overlapping events render side by side", () => {
	const html = render([calendarEvent("a", 10, 11), calendarEvent("b", 10.5, 11.5)]);
	assert.ok((html.match(/width:calc\(50% - 8px\)/g) ?? []).length >= 2);
	assert.match(html, /left:calc\(0% \+ 4px\)/);
	assert.match(html, /left:calc\(50% \+ 4px\)/);
	const apart = render([calendarEvent("a", 10, 11), calendarEvent("b", 12, 13)]);
	assert.doesNotMatch(apart, /(?:left|width):calc\(/);
	assert.match(apart, /left-1 right-1/);
});
