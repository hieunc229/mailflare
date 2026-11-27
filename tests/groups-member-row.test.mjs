import assert from "node:assert/strict";
import test from "node:test";
import { installDom, loadComponent } from "./helpers/dom-component.mjs";

installDom();
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const stubs = {
	"@/components/icons": `export const Mail = () => null; export const Users = () => null; export const X = () => null;`,
	"@/components/language-provider": `export function useLanguage() { return { t: (key, vars) => vars ? key + JSON.stringify(vars) : key }; }`,
	"@tanstack/react-query": `
		export function useQueryClient() { return { invalidateQueries() { globalThis.__invalidated += 1; } }; }
		export function useMutation(options) {
			const state = globalThis.__mutations;
			return {
				isPending: state.pending, isError: !!state.error, error: state.error,
				mutate: async (variables) => { try { await options.mutationFn(variables); options.onSuccess?.(); } catch (error) { state.error = error; } },
			};
		}`,
	"../utils": `
		export const jsonInit = (method, body) => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });
		export async function groupsFetch(url, fallback, init) { globalThis.__calls.push({ url, ...init }); }`,
};
const { MemberRow } = await loadComponent("src/app/(admin)/groups/[id]/member-row.tsx", stubs);

const member = (overrides = {}) => ({ id: "gm1", kind: "user", userId: "u1", mailboxId: null, email: null, canSendAs: false, hasPrimaryMailbox: true, name: "Alice Doe", address: "alice@example.com", disabled: false, suppressed: false, createdAt: "", ...overrides });
async function mount(t, props, mutations = {}) {
	globalThis.__calls = [];
	globalThis.__invalidated = 0;
	globalThis.__mutations = { pending: false, error: null, ...mutations };
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	t.after(async () => { await act(async () => root.unmount()); container.remove(); });
	await act(async () => { root.render(createElement("ul", null, createElement(MemberRow, { groupId: "g1", ...props }))); });
	return container;
}

test("a user member has a labelled Can send as group switch that mirrors the flag", async (t) => {
	for (const flag of [false, true]) {
		const container = await mount(t, { member: member({ canSendAs: flag }) });
		const toggle = container.querySelector('[role="switch"]');
		assert.ok(toggle, "switch present");
		assert.equal(toggle.getAttribute("aria-checked"), String(flag));
		assert.equal(container.querySelector(`label[for="${toggle.id}"]`)?.textContent.includes("groups.canSendAs"), true);
	}
});

test("turning the switch on patches the member and refreshes the group", async (t) => {
	const container = await mount(t, { member: member() });
	await act(async () => { container.querySelector('[role="switch"]').click(); });
	assert.deepEqual(globalThis.__calls, [{ url: "/api/groups/g1/members/gm1", method: "PATCH", body: JSON.stringify({ canSendAs: true }) }]);
	assert.equal(globalThis.__invalidated, 1);
});

test("turning it off sends canSendAs false", async (t) => {
	const container = await mount(t, { member: member({ canSendAs: true }) });
	await act(async () => { container.querySelector('[role="switch"]').click(); });
	assert.equal(JSON.parse(globalThis.__calls[0].body).canSendAs, false);
});

test("mailbox and outside members have no switch", async (t) => {
	for (const kind of ["mailbox", "external"]) {
		const container = await mount(t, { member: member({ kind, userId: null, mailboxId: kind === "mailbox" ? "m1" : null, email: kind === "external" ? "x@ext.com" : null }) });
		assert.equal(container.querySelector('[role="switch"]'), null, kind);
	}
});

test("the switch is disabled while saving and a failure is shown", async (t) => {
	const saving = await mount(t, { member: member() }, { pending: true });
	assert.equal(saving.querySelector('[role="switch"]').disabled, true);
	const failed = await mount(t, { member: member() }, { error: new Error("Only account members can be allowed to send as the group") });
	assert.equal(failed.querySelector('[role="alert"]')?.textContent.includes("Only account members"), true);
});

const accessibleName = (container, element) => element.getAttribute("aria-labelledby").split(/\s+/).map((id) => container.querySelector(`[id="${id}"]`)?.textContent ?? "").join(" ");

test("each switch is named by the action and the member, so two rows are told apart", async (t) => {
	const names = [];
	for (const [id, name] of [["gm1", "Alice Doe"], ["gm2", "Bob Roe"]]) {
		const container = await mount(t, { member: member({ id, name }) });
		const toggle = container.querySelector('[role="switch"]');
		const text = accessibleName(container, toggle);
		assert.match(text, /groups\.canSendAs/);
		assert.ok(text.includes(name), text);
		names.push(text);
	}
	assert.notEqual(names[0], names[1]);
});

test("a member without a primary mailbox gets a note that send-as will not show up for them, and the switch still works", async (t) => {
	const without = await mount(t, { member: member({ hasPrimaryMailbox: false }) });
	assert.ok(without.textContent.includes("groups.noPrimaryMailbox"));
	const toggle = without.querySelector('[role="switch"]');
	assert.equal(toggle.disabled, false);
	assert.ok(toggle.getAttribute("aria-describedby"), "the note is tied to the switch");
	assert.ok(without.querySelector(`[id="${toggle.getAttribute("aria-describedby")}"]`).textContent.includes("groups.noPrimaryMailbox"));
	const withMailbox = await mount(t, { member: member() });
	assert.ok(!withMailbox.textContent.includes("groups.noPrimaryMailbox"));
});
