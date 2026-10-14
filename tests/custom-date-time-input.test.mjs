import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-custom-date-time-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://mail.example/" });
for (const name of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "DocumentFragment", "NodeFilter", "Element", "Node", "Event", "CustomEvent", "FocusEvent", "MouseEvent", "KeyboardEvent", "PointerEvent", "MutationObserver", "FormData", "getComputedStyle"]) {
	globalThis[name] = name === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[name];
}
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLElement.prototype.hasPointerCapture = () => false;
dom.window.HTMLElement.prototype.setPointerCapture = () => {};
dom.window.HTMLElement.prototype.releasePointerCapture = () => {};
await build({ stdin: { contents: `import React, { act } from "react"; import { createRoot } from "react-dom/client"; import { Input } from "./src/components/ui/input"; import { DialogFrame } from "./src/components/dialog-frame"; import { InstallationDialogs, confirmAction } from "./src/components/ui/installation-dialogs"; import * as Dialog from "@radix-ui/react-dialog"; export { React, act, createRoot, Input, DialogFrame, InstallationDialogs, confirmAction, Dialog };`, resolveDir: root, loader: "tsx" }, outfile: join(outDir, "input.mjs"), bundle: true, platform: "browser", format: "esm", target: "es2022", tsconfig: join(root, "tsconfig.json"), external: ["react", "react-dom", "react-dom/client"], alias: { "@": join(root, "src") }, logLevel: "silent" });
const { React, act, createRoot, Input, DialogFrame, InstallationDialogs, confirmAction, Dialog } = await import(pathToFileURL(join(outDir, "input.mjs")).href);
const h = React.createElement;
async function mount(element) { const container = document.createElement("div"); document.body.append(container); const root = createRoot(container); await act(async () => root.render(element)); return { container, async cleanup() { await act(async () => root.unmount()); container.remove(); } }; }
async function click(element) { await act(async () => { element.click(); }); }

for (const type of ["date", "time", "datetime-local"]) {
	test(`${type} keeps a native input and opens only custom UI`, async () => {
		const ref = React.createRef();
		const view = await mount(h("form", null, h("label", { htmlFor: "when" }, "When"), h(Input, { id: "when", name: "when", type, required: true, ref })));
		const native = view.container.querySelector("input");
		const trigger = view.container.querySelector("button[aria-haspopup=dialog]");
		assert.equal(native, ref.current);
		assert.equal(native.type, type);
		assert.equal(native.checkValidity(), false);
		assert.equal(trigger.getAttribute("aria-label"), "When");
		await click(trigger);
		assert.ok(document.querySelector('[data-ui-date-time-popup]'));
		await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
		assert.equal(document.querySelector('[data-ui-date-time-popup]'), null);
		await view.cleanup();
	});
}

test("date selection skips invalid days, changes native value and resets", async () => {
	const changes = [];
	const view = await mount(h("form", null, h(Input, { type: "date", name: "day", defaultValue: "2026-10-14", min: "2026-10-14", max: "2026-10-17", onChange: (event) => changes.push(event.target.value), "aria-label": "Day" })));
	const form = view.container.querySelector("form");
	await click(view.container.querySelector('button[aria-haspopup="dialog"]'));
	assert.equal(document.querySelector('[data-date="2026-10-13"]').disabled, true);
	await click(document.querySelector('[data-date="2026-10-16"]'));
	assert.deepEqual(changes, ["2026-10-16"]);
	assert.equal(new FormData(form).get("day"), "2026-10-16");
	await act(async () => { form.reset(); await Promise.resolve(); });
	assert.equal(new FormData(form).get("day"), "2026-10-14");
	assert.match(view.container.querySelector('button[aria-haspopup="dialog"]').textContent, /Oct/);
	await view.cleanup();
});

test("controlled date selection updates through onChange", async () => {
	function Controlled() { const [value, setValue] = React.useState("2026-10-14"); return h(Input, { type: "date", value, onChange: (event) => setValue(event.target.value), "aria-label": "Date" }); }
	const view = await mount(h(Controlled));
	await click(view.container.querySelector('button[aria-haspopup="dialog"]'));
	await click(document.querySelector('[data-date="2026-10-20"]'));
	assert.equal(view.container.querySelector("input").value, "2026-10-20");
	await view.cleanup();
});

test("time choices honor a stepped minimum and max", async () => {
	const view = await mount(h("form", null, h(Input, { type: "time", name: "time", defaultValue: "09:30", min: "09:30", max: "10:30", step: 900, "aria-label": "Time" })));
	await click(view.container.querySelector('button[aria-haspopup="dialog"]'));
	const selects = document.querySelectorAll("[data-ui-date-time-popup] select[class]");
	assert.equal(selects.length, 2);
	assert.equal(selects[1].querySelector('option[value="15"]').disabled, true);
	assert.equal(selects[1].querySelector('option[value="45"]').disabled, false);
	await act(async () => { selects[1].value = "45"; selects[1].dispatchEvent(new Event("change", { bubbles: true })); });
	assert.equal(new FormData(view.container.querySelector("form")).get("time"), "09:45");
	await view.cleanup();
});

test("datetime date selection preserves time and enforces bounds", async () => {
	const view = await mount(h("form", null, h(Input, { type: "datetime-local", name: "when", defaultValue: "2026-10-14T10:15", min: "2026-10-14T10:00", max: "2026-10-16T18:00", "aria-label": "When" })));
	await click(view.container.querySelector('button[aria-haspopup="dialog"]'));
	assert.equal(document.querySelector('[data-date="2026-10-13"]').disabled, true);
	await click(document.querySelector('[data-date="2026-10-15"]'));
	assert.equal(new FormData(view.container.querySelector("form")).get("when"), "2026-10-15T10:15");
	await view.cleanup();
});

test("calendar keyboard navigation skips dates excluded by step", async () => {
	const view = await mount(h(Input, { type: "date", defaultValue: "2026-10-14", min: "2026-10-14", step: 2, "aria-label": "Date" }));
	await click(view.container.querySelector('button[aria-haspopup="dialog"]'));
	const grid = document.querySelector('[role="grid"]');
	assert.equal(document.querySelector('[data-date="2026-10-15"]').disabled, true);
	await act(async () => { grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
	assert.equal(document.querySelector('[data-date="2026-10-16"]').tabIndex, 0);
	await click(document.querySelector('[data-date="2026-10-16"]'));
	assert.equal(view.container.querySelector("input").value, "2026-10-16");
	await view.cleanup();
});

test("outside pointer closes the picker", async () => {
	const view = await mount(h(Input, { type: "date", defaultValue: "2026-10-14", "aria-label": "Date" }));
	await click(view.container.querySelector('button[aria-haspopup="dialog"]'));
	await act(async () => { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
	assert.equal(document.querySelector('[data-ui-date-time-popup]'), null);
	await view.cleanup();
});

test("picker escapes an overflow-hidden dialog and stays in the viewport", async () => {
	const view = await mount(h("div", { style: { overflow: "hidden", height: 24 } }, h(Input, { type: "datetime-local", defaultValue: "2026-10-14T10:15", "aria-label": "When" })));
	const trigger = view.container.querySelector('button[aria-haspopup="dialog"]');
	trigger.getBoundingClientRect = () => ({ left: 950, right: 1030, top: 730, bottom: 770, width: 80, height: 40 });
	await click(trigger);
	const popup = document.querySelector('[data-ui-date-time-popup]');
	assert.ok(popup);
	assert.equal(view.container.contains(popup), false);
	assert.equal(popup.style.position, "fixed");
	assert.ok(parseFloat(popup.style.left) + parseFloat(popup.style.width) <= window.innerWidth - 8);
	assert.ok(parseFloat(popup.style.top) < 730);
	assert.equal(trigger.getAttribute("aria-controls"), popup.id);
	await view.cleanup();
});

test("bounded datetime calendar checks avoid minute-by-minute probes", async () => {
	const create = document.createElement.bind(document);
	let probes = 0;
	document.createElement = function (tagName, ...args) { if (tagName === "input") probes++; return create(tagName, ...args); };
	try {
		const view = await mount(h(Input, { type: "datetime-local", defaultValue: "2026-10-14T10:15", min: "2026-10-14T10:00", max: "2026-10-16T18:00", "aria-label": "When" }));
		probes = 0;
		await click(view.container.querySelector('button[aria-haspopup="dialog"]'));
		assert.ok(probes < 300, `opened picker with ${probes} validity probes`);
		await view.cleanup();
	} finally { document.createElement = create; }
});

test("time dropdown remains usable inside the portaled picker", async () => {
	const view = await mount(h(Input, { type: "time", defaultValue: "09:30", "aria-label": "Time" }));
	await click(view.container.querySelector('button[aria-haspopup="dialog"]'));
	const hour = document.querySelector('[data-ui-date-time-popup] [role="combobox"]');
	assert.ok(hour);
	await act(async () => { hour.focus(); hour.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
	assert.ok(document.querySelector('[data-ui-popup="select"]'));
	assert.ok(document.querySelector('[data-ui-date-time-popup]'));
	const option = Array.from(document.querySelectorAll('[role="option"]')).find((node) => node.textContent.includes("10"));
	assert.ok(option);
	await act(async () => { option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
	assert.equal(view.container.querySelector("input").value, "10:30");
	assert.ok(document.querySelector('[data-ui-date-time-popup]'));
	await view.cleanup();
});

test("picker remains operable inside a parent Radix modal", async () => {
	const view = await mount(h(Dialog.Root, { open: true }, h(Dialog.Portal, null, h(Dialog.Content, { "aria-describedby": undefined, style: { overflow: "hidden" } }, h(Dialog.Title, null, "Schedule"), h(Input, { type: "date", defaultValue: "2026-10-14", "aria-label": "Date" })))));
	const trigger = document.querySelector('button[aria-haspopup="dialog"]');
	await click(trigger);
	const popup = document.querySelector('[data-ui-date-time-popup]');
	assert.ok(popup);
	assert.notEqual(popup.getAttribute("aria-hidden"), "true");
	await click(popup.querySelector('[data-date="2026-10-15"]'));
	assert.equal(document.querySelector('input[type="date"]').value, "2026-10-15");
	assert.ok(document.querySelector('[role="dialog"]'), "parent dialog stays open");
	await view.cleanup();
});

test("a DialogFrame contains ordinary Tab focus but yields to its portaled picker", async () => {
	const view = await mount(h(DialogFrame, { label: "Edit event", onClose() {} }, h("button", null, "First"), h(Input, { type: "date", defaultValue: "2026-10-14", "aria-label": "Date" }), h("button", null, "Last")));
	const frame = view.container.querySelector('[role="dialog"]');
	const buttons = frame.querySelectorAll("button");
	for (const button of buttons) Object.defineProperty(button, "offsetParent", { configurable: true, value: document.body });
	buttons[buttons.length - 1].focus();
	await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
	assert.equal(document.activeElement, buttons[0], "ordinary Tab wraps inside the frame");
	buttons[0].blur();
	await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
	assert.equal(document.activeElement, buttons[0], "focus outside the frame is contained");
	await click(frame.querySelector('button[aria-haspopup="dialog"]'));
	const day = document.querySelector('[data-ui-date-time-popup] [data-date="2026-10-14"]');
	day.focus();
	await act(async () => { day.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
	const focusStayedInPicker = document.querySelector('[data-ui-date-time-popup]')?.contains(document.activeElement);
	await view.cleanup();
	assert.equal(focusStayedInPicker, true, "parent frame must leave picker focus alone");
});

test("a DialogFrame yields Tab to a nested portaled modal", async () => {
	function Nested() {
		const [open, setOpen] = React.useState(false);
		return h(DialogFrame, { label: "Edit event", onClose() {} },
			h("button", { onClick: () => setOpen(true) }, "Open confirmation"),
			h("button", null, "Last parent control"),
			h(Dialog.Root, { open, onOpenChange: setOpen }, h(Dialog.Portal, null,
				h(Dialog.Content, { "aria-describedby": undefined }, h(Dialog.Title, null, "Confirm"), h("button", null, "Cancel"), h("button", null, "Continue")))));
	}
	const view = await mount(h(Nested));
	for (const button of view.container.querySelectorAll("button")) Object.defineProperty(button, "offsetParent", { configurable: true, value: document.body });
	await click(view.container.querySelector("button"));
	const nested = document.querySelectorAll('[role="dialog"]')[1];
	const cancel = Array.from(nested.querySelectorAll("button")).find((button) => button.textContent === "Cancel");
	cancel.focus();
	await act(async () => { cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
	const focusStayedNested = nested.contains(document.activeElement);
	await view.cleanup();
	assert.equal(focusStayedNested, true, "parent frame must leave confirmation focus alone");
});

test("a DialogFrame yields Tab to InstallationDialogs confirmation", async () => {
	const view = await mount(h(React.Fragment, null,
		h(DialogFrame, { label: "Edit event", onClose() {} },
			h(Input, { type: "datetime-local", defaultValue: "2026-10-14T10:15", "aria-label": "Event date and time" }),
			h("button", { onClick: () => void confirmAction("Delete event?") }, "Delete")),
		h(InstallationDialogs)));
	for (const button of view.container.querySelectorAll("button")) Object.defineProperty(button, "offsetParent", { configurable: true, value: document.body });
	await click(Array.from(view.container.querySelectorAll("button")).find((button) => button.textContent === "Delete"));
	const nested = Array.from(document.querySelectorAll('[role="dialog"]')).at(-1);
	assert.equal(nested.getAttribute("aria-modal"), null, "test the actual Radix dialog semantics");
	const cancel = Array.from(nested.querySelectorAll("button")).find((button) => button.textContent === "Cancel");
	assert.ok(cancel);
	await act(async () => { cancel.focus(); cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
	const focusStayedNested = nested.contains(document.activeElement);
	await click(cancel);
	await view.cleanup();
	assert.equal(focusStayedNested, true, "parent frame must leave the actual confirmation focus alone");
});

test("a DialogFrame yields Tab to a select portaled from its time picker", async () => {
	const view = await mount(h(DialogFrame, { label: "Edit event", onClose() {} }, h("button", null, "First"), h(Input, { type: "time", defaultValue: "09:30", "aria-label": "Time" }), h("button", null, "Last")));
	for (const button of view.container.querySelectorAll("button")) Object.defineProperty(button, "offsetParent", { configurable: true, value: document.body });
	await click(view.container.querySelector('button[aria-haspopup="dialog"]'));
	const hour = document.querySelector('[data-ui-date-time-popup] [role="combobox"]');
	await act(async () => { hour.focus(); hour.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
	const option = document.querySelector('[data-ui-popup="select"] [role="option"]');
	assert.ok(option);
	await act(async () => { option.focus(); option.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
	const focusStayedNested = document.querySelector('[data-ui-popup="select"]')?.contains(document.activeElement);
	await view.cleanup();
	assert.equal(focusStayedNested, true, "parent frame must leave nested time options alone");
});

test("clicking a child of the open date trigger closes the picker", async () => {
	const view = await mount(h(Input, { type: "date", defaultValue: "2026-10-14", "aria-label": "Date" }));
	const child = view.container.querySelector('button[aria-haspopup="dialog"] span');
	await click(child);
	assert.ok(document.querySelector('[data-ui-date-time-popup]'));
	await act(async () => { child.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
	assert.ok(document.querySelector('[data-ui-date-time-popup]'), "pointerdown on trigger child must not dismiss the popup");
	await click(child);
	assert.equal(document.querySelector('[data-ui-date-time-popup]'), null);
	await view.cleanup();
});
