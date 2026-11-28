import assert from "node:assert/strict";
import test from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const { ConversationNotesProvider } = await loadComponent("src/components/messages/conversation-notes-context.tsx", {
	"@/lib/auth/client": `export async function authFetch(url) { globalThis.__noteFetches.push(url); return { ok: true, json: async () => ({ notes: [] }) }; }`,
});

async function mount(t, liveRefresh) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	t.after(async () => { await act(async () => root.unmount()); container.remove(); });
	const render = (live) => act(async () => { root.render(createElement(ConversationNotesProvider, { messageId: "m1", emails: [], liveRefresh: live }, null)); });
	await render(liveRefresh);
	return render;
}
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });

test("a hidden provider does not refetch on mail events and loads again when it goes live", async (t) => {
	globalThis.__noteFetches = [];
	Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
	const render = await mount(t, false);
	assert.equal(globalThis.__noteFetches.length, 1);
	window.dispatchEvent(new window.Event("mailflare:messages-changed"));
	await settle();
	assert.equal(globalThis.__noteFetches.length, 1);
	await render(true);
	assert.equal(globalThis.__noteFetches.length, 2);
	window.dispatchEvent(new window.Event("mailflare:messages-changed"));
	await settle();
	assert.equal(globalThis.__noteFetches.length, 3);
});
