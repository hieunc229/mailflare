import assert from "node:assert/strict";
import test from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

const passthroughUi = `
import React from "react";
import { createPortal } from "react-dom";
export function Button({children, size, variant, pill, ...p}) { return React.createElement("button", p, children); }
export function Input({size, variant, containerClassName, ...p}) { return React.createElement("input", p); }
export function Label({children, ...p}) { return React.createElement("label", p, children); }
export function Textarea(p) { return React.createElement("textarea", p); }
export function Dialog({open, onOpenChange, children}) { return open ? children : null; }
export function DialogContent({children}) { return createPortal(React.createElement("div", {role: "dialog"}, children), document.body); }
export function DialogHeader({children}) { return React.createElement("div", {}, children); }
export function DialogTitle({children}) { return React.createElement("h2", {}, children); }
export function DialogFooter({children}) { return React.createElement("div", {}, children); }
`;
const language = `export function useLanguage() { return { t: (key) => key }; }`;

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

async function mount(t, element) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	t.after(async () => { await act(async () => root.unmount()); container.remove(); });
	await act(async () => { root.render(element); });
	return container;
}

test("submitting the new-template dialog does not submit the surrounding composer form", async (t) => {
	globalThis.__fetchLog = [];
	const { NewTemplateDialog } = await loadComponent("src/components/compose/new-template-dialog.tsx", {
		"@/components/language-provider": language,
		"@/components/ui/button": passthroughUi,
		"@/components/ui/dialog": passthroughUi,
		"@/components/ui/input": passthroughUi,
		"@/components/ui/label": passthroughUi,
		"@/components/ui/textarea": passthroughUi,
		"@/lib/auth/client": `export async function authFetch(url) { globalThis.__fetchLog.push(url); return { ok: true, async json() { return {}; } }; }`,
	});
	let composerSubmits = 0;
	await mount(t, createElement("form", { onSubmit: (event) => { event.preventDefault(); composerSubmits++; } },
		createElement(NewTemplateDialog, { open: true, onOpenChange() {}, mailboxId: "m", from: "a@example.com" })));
	const dialogForm = document.querySelector('[role="dialog"] form');
	assert.ok(dialogForm, "template form renders inside the composer form");
	await act(async () => { dialogForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
	assert.deepEqual(globalThis.__fetchLog, ["/api/templates"], "the template is saved");
	assert.equal(composerSubmits, 0, "the composer form must not receive the submit");
});

test("notes popover closes on Escape inside it, but not from a dialog opened over it", async (t) => {
	const { MessageNotesPopover } = await loadComponent("src/components/messages/message-notes-popover.tsx", {
		"@/components/icons": `export function Note() { return null; }`,
		"@/components/language-provider": language,
		"./conversation-notes-context": `
import React from "react";
export function ConversationNotesProvider({children}) { return children; }
export function useConversationNotes() { return { loading: false, notes: [{ id: "n1" }] }; }`,
		"./conversation-notes": `
import React from "react";
export function NotesBody() { return React.createElement("input", { "data-note-input": true }); }`,
	});
	const container = await mount(t, createElement("div", {},
		createElement(MessageNotesPopover, { messageId: "msg", count: 1 }),
		createElement("div", { role: "alertdialog", "data-confirm": true }, createElement("button", { type: "button" }, "Cancel"))));
	const panel = () => document.querySelector('[role="dialog"][aria-label="note.title"]');
	const escape = (target) => target.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

	await act(async () => { container.querySelector("button").click(); });
	assert.ok(panel(), "popover opens");

	const confirm = container.querySelector("[data-confirm]");
	await act(async () => { escape(confirm.querySelector("button")); });
	assert.ok(panel(), "Escape from the confirm dialog leaves the popover open");

	await act(async () => { escape(panel().querySelector("input")); });
	assert.equal(panel(), null, "Escape inside the popover closes it");
});

test("bulk bar asks before deleting forever and does nothing when declined", async (t) => {
	globalThis.__bulk = { calls: [], confirmed: [], answer: false };
	const { BulkMessageActionBar } = await loadComponent("src/components/messages/bulk-message-action-bar.tsx", {
		"@/components/language-provider": language,
		"@/components/ui/confirm-dialog": `export async function confirmDestructive(text) { globalThis.__bulk.confirmed.push(text); return globalThis.__bulk.answer; }`,
		"./bulk-message-toolbar": `
import React from "react";
export function BulkMessageToolbar({ onAction }) { return React.createElement("button", { "data-delete": true, onClick: () => onAction("delete") }, "Delete forever"); }`,
		"./utils": `export async function runBulkMessageAction(ids, action) { globalThis.__bulk.calls.push([ids, action]); }`,
	});
	const cleared = [];
	const container = await mount(t, createElement(BulkMessageActionBar, {
		folder: "trash",
		selectedMessages: [{ id: "a", read: true }, { id: "b", read: true }],
		onClearSelection: () => cleared.push(true),
	}));
	await act(async () => { container.querySelector("[data-delete]").click(); });
	assert.equal(globalThis.__bulk.confirmed.length, 1, "a confirmation is shown");
	assert.deepEqual(globalThis.__bulk.calls, [], "declining deletes nothing");

	globalThis.__bulk.answer = true;
	await act(async () => { container.querySelector("[data-delete]").click(); });
	assert.deepEqual(globalThis.__bulk.calls, [[["a", "b"], "delete"]]);
});
