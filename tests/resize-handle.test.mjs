import assert from "node:assert/strict";
import test from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ResizeHandle } = await loadComponent("src/components/ui/resize-handle.tsx");

async function mount(t, element) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	t.after(async () => { await act(async () => root.unmount()); container.remove(); });
	await act(async () => { root.render(element); });
	return container;
}

test("the separator is keyboard operable and wraps each key press in start/resize/end", async (t) => {
	const calls = [];
	const container = await mount(t, createElement(ResizeHandle, {
		label: "Resize",
		onResizeStart: () => calls.push("start"),
		onResize: (delta) => calls.push(delta),
		onResizeEnd: () => calls.push("end"),
	}));
	const separator = container.querySelector('[role="separator"]');
	assert.equal(separator.getAttribute("tabindex"), "0");
	const press = (key, shiftKey = false) => act(async () => { separator.dispatchEvent(new window.KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })); });
	await press("ArrowRight");
	assert.deepEqual(calls, ["start", 16, "end"]);
	calls.length = 0;
	await press("ArrowLeft", true);
	assert.deepEqual(calls, ["start", -64, "end"]);
	calls.length = 0;
	await press("Enter");
	assert.deepEqual(calls, []);
});
