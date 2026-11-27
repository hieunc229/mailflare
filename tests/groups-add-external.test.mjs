import assert from "node:assert/strict";
import test from "node:test";
import { installDom, loadComponent } from "./helpers/dom-component.mjs";

installDom();
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const stubs = {
	"@/components/icons": `export const Mail = () => null; export const Search = () => null; export const Users = () => null;`,
	"@/components/language-provider": `export function useLanguage() { return { t: (key, vars) => vars ? key + JSON.stringify(vars) : key }; }`,
	"@/lib/auth/client": `export async function authFetch() { throw new Error("not used"); }`,
	"@tanstack/react-query": `
		export function useQueryClient() { return { invalidateQueries() {} }; }
		export function useQuery() { return { data: { candidates: [] }, isFetching: false, isError: false }; }
		export function useMutation(options) { return { mutate(c) { globalThis.__added.push(c); options.onSuccess?.(globalThis.__response ?? {}, c); }, isPending: false, isError: false }; }`,
};
const { AddMembers } = await loadComponent("src/app/(admin)/groups/[id]/add-members.tsx", stubs);
const utils = await loadComponent("src/app/(admin)/groups/utils.ts", { "@/lib/auth/client": `export async function authFetch() {}` });

async function mount(t, props = {}) {
	globalThis.__added = [];
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	t.after(async () => { await act(async () => root.unmount()); container.remove(); });
	await act(async () => { root.render(createElement(AddMembers, { groupId: "g1", disabled: false, ...props })); });
	return container;
}
async function type(container, value) {
	const input = container.querySelector("input");
	const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
	await act(async () => { input.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true })); });
	await act(async () => { setter.call(input, value); input.dispatchEvent(new window.Event("input", { bubbles: true })); });
	return input;
}
const options = (container) => [...container.querySelectorAll('[role="option"]')];

test("typing an email offers it as an external member", async (t) => {
	const container = await mount(t);
	await type(container, "  Pat@Ext.com ");
	assert.equal(options(container).length, 1);
	assert.match(options(container)[0].textContent, /pat@ext\.com/);
	assert.match(options(container)[0].textContent, /groups\.kindExternal/);
	await type(container, "not an address");
	assert.equal(options(container).length, 0);
});

test("choosing it asks first, spelling out that each copy is a billed send, and adds only on confirm", async (t) => {
	const container = await mount(t);
	const input = await type(container, "pat@ext.com");
	await act(async () => { options(container)[0].dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true })); });
	assert.deepEqual(globalThis.__added, [], "nothing is added yet");
	const panel = container.querySelector('[data-testid="external-confirm"]');
	assert.ok(panel);
	assert.match(panel.textContent, /groups\.externalCostConfirm.*pat@ext\.com/);
	const [confirm, cancel] = panel.querySelectorAll("button");
	await act(async () => { cancel.click(); });
	assert.equal(container.querySelector('[data-testid="external-confirm"]'), null);
	assert.deepEqual(globalThis.__added, []);
	await type(container, "pat@ext.com");
	await act(async () => { options(container)[0].dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true })); });
	await act(async () => { container.querySelector('[data-testid="external-confirm"] button').click(); });
	assert.deepEqual(globalThis.__added.map((a) => [a.kind, a.id]), [["external", "pat@ext.com"]]);
	assert.equal(container.querySelector('[data-testid="external-confirm"]'), null);
	void confirm; void input;
});

test("an address that is already a member, or a group at its external limit, offers nothing", async (t) => {
	const member = await mount(t, { memberAddresses: ["pat@ext.com"] });
	await type(member, "PAT@ext.com");
	assert.equal(options(member).length, 0);
	const full = await mount(t, { externalFull: true });
	await type(full, "new@ext.com");
	assert.equal(options(full).length, 0);
});

test("externalOption recognises plain addresses only, and the members body carries kind and email", () => {
	assert.equal(utils.externalOption("  A@B.co ", []), "a@b.co");
	assert.equal(utils.externalOption("a@b.co", ["A@b.co"]), null);
	for (const bad of ["", "a", "a@b", "A <a@b.co>", "a@b.co, c@d.co", "a b@c.de"]) assert.equal(utils.externalOption(bad, []), null, bad);
	assert.deepEqual(utils.memberBody({ kind: "external", id: "a@b.co", name: "a@b.co", address: "a@b.co" }), { kind: "external", email: "a@b.co" });
	assert.deepEqual(utils.memberBody({ kind: "user", id: "u1", name: "A", address: "a@x" }), { kind: "user", userId: "u1" });
	assert.deepEqual(utils.memberBody({ kind: "mailbox", id: "m1", name: "A", address: "a@x" }), { kind: "mailbox", mailboxId: "m1" });
	assert.equal(utils.MAX_EXTERNAL_MEMBERS, 100);
});

test("adding someone who unsubscribed from this group before tells the admin", async (t) => {
	const container = await mount(t);
	globalThis.__response = { added: [{}], warnings: [{ email: "pat@ext.com", reason: "previously_unsubscribed" }] };
	t.after(() => { delete globalThis.__response; });
	await type(container, "pat@ext.com");
	await act(async () => { options(container)[0].dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true })); });
	await act(async () => { container.querySelector('[data-testid="external-confirm"] button').click(); });
	const warning = container.querySelector('[data-testid="resubscribed"]');
	assert.ok(warning);
	assert.match(warning.textContent, /groups\.resubscribed.*pat@ext\.com/);
});
