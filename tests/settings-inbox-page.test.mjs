import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { loadComponent } from "./helpers/dom-component.mjs";

const components = {
	"appearance-settings": "AppearanceSettings",
	"inbox-reading-layout-settings": "InboxReadingLayoutSettings",
	"inbox-threading-settings": "InboxThreadingSettings",
	"recipient-address-settings": "RecipientAddressSettings",
	"compose-defaults-settings": "ComposeDefaultsSettings",
	"inbox-shortcuts-settings": "InboxShortcutsSettings",
	"browser-notification-settings": "BrowserNotificationSettings",
	"push-notification-settings": "PushNotificationSettings",
	"spam-filter-settings": "SpamFilterSettings",
	"promotions-settings": "PromotionsSettings",
	"remote-content-settings": "RemoteContentSettings",
	"trash-retention-settings": "TrashRetentionSettings",
	"mailbox-auto-reply-form": "MailboxAutoReplyForm",
};
const stubs = { "@/lib/i18n/server": "export const getServerTranslator = async () => (key) => key;" };
for (const [file, name] of Object.entries(components)) {
	stubs[`@/components/settings/${file}`] = `export const ${name} = () => <i data-c="${name}" />;`;
}

const keys = ["appearance", "readingLayout", "threading", "addresses", "compose", "shortcuts", "notifications", "spamProtection", "promotions", "remoteContent", "cleanup", "autoReply"];

test("settings inbox page keeps its sections in order", async () => {
	const mod = await loadComponent("src/app/(settings)/settings/inbox/page.tsx", stubs);
	const html = renderToStaticMarkup(await mod.default());
	assert.deepEqual(
		[...html.matchAll(/data-c="(\w+)"/g)].map((m) => m[1]),
		["AppearanceSettings", "InboxReadingLayoutSettings", "InboxThreadingSettings", "RecipientAddressSettings", "ComposeDefaultsSettings", "InboxShortcutsSettings", "BrowserNotificationSettings", "PushNotificationSettings", "SpamFilterSettings", "PromotionsSettings", "RemoteContentSettings", "TrashRetentionSettings", "MailboxAutoReplyForm"],
	);
	assert.deepEqual(
		[...html.matchAll(/<h3[^>]*>([^<]*)<\/h3>/g)].map((m) => m[1]),
		keys.map((key) => `settingsPage.inbox.${key}`),
	);
	assert.deepEqual(
		[...html.matchAll(/<p class="mt-1 text-sm text-neutral-500">([^<]*)<\/p>/g)].map((m) => m[1]).filter((text) => keys.some((key) => text === `settingsPage.inbox.${key}Description`)),
		keys.map((key) => `settingsPage.inbox.${key}Description`),
	);
	assert.equal((html.match(/<h2/g) ?? []).length, 2);
});
