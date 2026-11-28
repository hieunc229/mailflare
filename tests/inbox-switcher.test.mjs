import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { installDom, loadComponent } from "./helpers/dom-component.mjs";

installDom();
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const A = { id: "a", name: "A", localPart: "a", hostname: "x.test", type: "personal" };
const B = { id: "b", name: "B", localPart: "b", hostname: "x.test", type: "shared" };

const { InboxSwitcher } = await loadComponent("src/components/settings/inbox-switcher.tsx", {
	"@/components/icons": "export const Check = () => null, ChevronDown = () => null, UsersRound = () => null;",
	"@/components/use-dismissible": "export function useDismissible() {}",
	"@/components/language-provider": "const t = (key) => key; export function useLanguage() { return { t }; }",
	"@/components/mailbox-provider": `const A = ${JSON.stringify(A)}, B = ${JSON.stringify(B)}; export function useSelectedMailbox() { return { selectedMailbox: A, mailboxes: [A, B], setSelectedMailbox() {} }; }`,
	"@/components/progressive-avatar-image": "export const ProgressiveAvatarImage = () => null;",
	"@/components/mailbox-selector-utils": "export const getAccountInitial = (n) => n[0]; export const getMailboxAddress = (m) => m.localPart + '@' + m.hostname; export const getMailboxName = (m) => m.name;",
	"@/lib/avatar-colors": "export const getAvatarColorStyle = () => ({});",
});

test("the inbox switcher is plain buttons and marks the current inbox", async (t) => {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	t.after(async () => { await act(async () => root.unmount()); container.remove(); });
	await act(async () => { root.render(createElement(InboxSwitcher)); });
	await act(async () => { container.querySelector("button").click(); });
	assert.equal(container.querySelector('[role="listbox"], [role="option"]'), null);
	assert.equal(container.querySelector("[aria-haspopup]"), null);
	const buttons = [...container.querySelectorAll("button")];
	const current = buttons.filter((b) => b.getAttribute("aria-current") === "true");
	assert.equal(current.length, 1);
	assert.ok(current[0].textContent.includes("a@x.test"));
});

test("profile form status messages are announced", () => {
	const source = readFileSync("src/components/settings/profile-form.tsx", "utf8");
	assert.ok((source.match(/role=\{[^}]*"alert"[^}]*"status"[^}]*\}|role="status"/g) ?? []).length >= 2);
});
