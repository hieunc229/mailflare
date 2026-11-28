import assert from "node:assert/strict";
import test from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const React = `import React from "react";`;
const nothing = (...names) => `${React} ${names.map((name) => `export const ${name} = () => null;`).join(" ")}`;
const { ConversationMessageCard } = await loadComponent("src/components/messages/conversation-thread.tsx", {
	"@/components/icons": nothing("ChevronsUpDown", "Paperclip"),
	"@/components/contacts/contact-avatar": nothing("ContactAvatar"),
	"@/components/messages/quoted-email-toggle": nothing("QuotedEmailToggle"),
	"@/components/message-actions/utils": "export const runSingleMessageAction = async () => undefined;",
	"./email-html-renderer": nothing("EmailHtmlRenderer"),
	"./use-remote-content": "export function useRemoteContent() { globalThis.__remoteCalls += 1; return { autoAllow: false, allowSender() {} }; }",
	"@/app/(dashboard)/inbox/[messageId]/utils": "export const getMessageBodyDisplay = (text, html) => ({ html, text, quotedHtml: null }); export const resolveInlineAttachmentUrls = (html) => html;",
	"@/components/language-provider": "export function useLanguage() { return { t: (key) => key }; }",
	"./thread-message-actions": nothing("ThreadMessageActions"),
	"./message-details-panel": nothing("MessageDetailsPopover"),
	"./sender-check-notice": nothing("SenderCheckBadge", "SenderCheckNotice"),
	"./message-open-status": nothing("MessageOpenStatus"),
	"@/components/follow-ups/message-follow-up-status": nothing("MessageFollowUpStatus"),
	"@/components/ui/button": `${React} export const Button = (p) => React.createElement("button", { onClick: p.onClick }, p.children);`,
	"./message-list-visibility": "export const useMessageListVisibility = () => ({ visible: true });",
	"../agent/assistant-open-state": "export const useAssistantOpen = () => false;",
});

const message = (id) => ({
	id, userId: "u", mailboxId: "m", folderId: null, direction: "inbound", providerMessageId: null, fromAddr: "A <a@example.com>", toAddr: "b@example.com",
	subject: "s", snippet: "hi", textBody: "hello", htmlBody: "<p>hello</p>", status: "received", read: true, starred: false, attachments: [],
	createdAt: "2026-01-01T00:00:00Z", receivedAt: "2026-01-01T00:00:00Z",
});

async function render(t, ...cards) {
	globalThis.__remoteCalls = 0;
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	t.after(async () => { await act(async () => root.unmount()); container.remove(); });
	await act(async () => { root.render(createElement("div", null, ...cards.map(([id, defaultExpanded]) => createElement(ConversationMessageCard, { key: id, message: message(id), mailboxId: "m", defaultExpanded })))); });
	return globalThis.__remoteCalls;
}

test("collapsed cards do not load the remote-content policy", async (t) => {
	assert.equal(await render(t, ["a", false], ["b", false], ["c", false]), 0);
});

test("an expanded card loads it once", async (t) => {
	assert.equal(await render(t, ["a", false], ["b", true], ["c", false]), 1);
});
