import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

test("an event button is named by title, date and time range", async (t) => {
	const { DayEvents } = await loadComponent("src/app/(calendar)/calendar/day-events.tsx", {
		"@/components/language-provider": `export function useLanguage() { return { t: (key) => key }; }`,
	});
	const noop = () => {};
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	t.after(async () => { await act(async () => root.unmount()); container.remove(); });
	const event = {
		id: "e1", title: "Standup", description: "", location: "", attendees: "", color: "blue", repeat: "none", repeatDays: "",
		repeatAnchorDay: null, repeatUntil: null, excludedOccurrences: "",
		startsAt: new Date(2026, 5, 3, 9, 0).toISOString(), endsAt: new Date(2026, 5, 3, 10, 0).toISOString(),
	};
	await act(async () => {
		root.render(createElement("div", { style: { position: "relative" } }, createElement(DayEvents, {
			day: new Date(2026, 5, 3), events: [event], currentTime: 0, busy: false, activeEventId: null,
			onEdit: noop, onDragStart: noop, onDragEnd: noop, onResizeStart: noop, onResizeMove: noop, onResizeEnd: noop, onResizeCancel: noop,
		})));
	});
	const button = container.querySelector("button[title]");
	assert.ok(button, "event button renders");
	const label = button.getAttribute("aria-label");
	assert.match(label, /^Standup, /);
	assert.match(label, /2026/);
	assert.ok(label.endsWith(button.getAttribute("title").split(" · ")[1]), label);
});

test("week and day columns are labelled groups", () => {
	const source = readFileSync(new URL("../src/app/(calendar)/calendar/page.tsx", import.meta.url), "utf8");
	const at = source.indexOf('<div key={dateKey(day)} role="group"');
	assert.ok(at > -1, "day column carries role=group");
	assert.match(source.slice(at, at + 300), /aria-label=\{formatUserDate\(day, \{ dateStyle: "full" \}\)\}/);
});
