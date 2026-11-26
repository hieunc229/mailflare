import assert from "node:assert/strict";
import test from "node:test";
import { installDom, loadComponent } from "./helpers/dom-component.mjs";

// React reads the DOM globals when it loads, so they must exist before the import below.
installDom();

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const candidates = [
	{ kind: "user", id: "u1", name: "Alice Doe", address: "alice@example.com" },
	{ kind: "mailbox", id: "m1", name: "support", address: "support@example.com" },
];
const stubs = {
	"@/components/icons": `export const Mail = () => null; export const Search = () => null; export const Users = () => null;`,
	"@/components/language-provider": `export function useLanguage() { return { t: (key, vars) => vars ? key + JSON.stringify(vars) : key }; }`,
	"@/lib/auth/client": `export async function authFetch() { throw new Error("not used"); }`,
	"@tanstack/react-query": `
		export function useQueryClient() { return { invalidateQueries() {} }; }
		export function useQuery() { return { data: { candidates: globalThis.__candidates }, isFetching: false, isError: false }; }
		export function useMutation() { return { mutate(c) { globalThis.__added.push(c.id); }, isPending: false, isError: false }; }`,
};
const { AddMembers } = await loadComponent("src/app/(admin)/groups/[id]/add-members.tsx", stubs);

async function mount(t, props = {}) {
	globalThis.__candidates = candidates;
	globalThis.__added = [];
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	t.after(async () => { await act(async () => root.unmount()); container.remove(); });
	await act(async () => { root.render(createElement(AddMembers, { groupId: "g1", disabled: false, ...props })); });
	return container;
}
const key = (input, name) => act(async () => { input.dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); });

test("the combobox exposes the ARIA pattern and is keyboard operable", async (t) => {
	const container = await mount(t);
	const input = container.querySelector("input");
	const list = container.querySelector('[role="listbox"]');
	assert.equal(input.getAttribute("role"), "combobox");
	assert.equal(input.getAttribute("aria-controls"), list.id);
	assert.equal(input.getAttribute("aria-expanded"), "false");
	assert.equal(container.querySelector(`label[for="${input.id}"]`)?.textContent, "groups.addMembers");

	await act(async () => { input.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true })); });
	assert.equal(input.getAttribute("aria-expanded"), "true");
	const options = [...container.querySelectorAll('[role="option"]')];
	assert.equal(options.length, 2);

	await key(input, "ArrowDown");
	assert.equal(input.getAttribute("aria-activedescendant"), options[0].id);
	assert.equal(options[0].getAttribute("aria-selected"), "true");
	await key(input, "ArrowDown");
	assert.equal(input.getAttribute("aria-activedescendant"), options[1].id);
	await key(input, "ArrowDown");
	assert.equal(input.getAttribute("aria-activedescendant"), options[0].id, "wraps around");
	await key(input, "ArrowUp");
	await key(input, "Enter");
	assert.deepEqual(globalThis.__added, ["m1"]);

	await key(input, "Escape");
	assert.equal(input.getAttribute("aria-expanded"), "false");
});

test("a full group disables the search and says why", async (t) => {
	const container = await mount(t, { disabled: true });
	const input = container.querySelector("input");
	assert.equal(input.disabled, true);
	assert.equal(input.placeholder, "groups.memberLimit");
});
