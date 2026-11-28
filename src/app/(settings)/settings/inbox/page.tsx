import { getServerTranslator } from "@/lib/i18n/server";
import { AppearanceSettings } from "@/components/settings/appearance-settings";
import { InboxThreadingSettings } from "@/components/settings/inbox-threading-settings";
import { RemoteContentSettings } from "@/components/settings/remote-content-settings";
import { RecipientAddressSettings } from "@/components/settings/recipient-address-settings";
import { ComposeDefaultsSettings } from "@/components/settings/compose-defaults-settings";
import { InboxReadingLayoutSettings } from "@/components/settings/inbox-reading-layout-settings";
import { InboxShortcutsSettings } from "@/components/settings/inbox-shortcuts-settings";
import { MailboxAutoReplyForm } from "@/components/settings/mailbox-auto-reply-form";
import { SpamFilterSettings } from "@/components/settings/spam-filter-settings";
import { TrashRetentionSettings } from "@/components/settings/trash-retention-settings";
import { PromotionsSettings } from "@/components/settings/promotions-settings";
import { PushNotificationSettings } from "@/components/settings/push-notification-settings";
import { BrowserNotificationSettings } from "@/components/settings/browser-notification-settings";

/** Each key needs `settingsPage.inbox.<key>` and `<key>Description` strings; the `t` calls below fail to compile when one is missing. */
type InboxSectionKey = "appearance" | "readingLayout" | "threading" | "addresses" | "compose" | "shortcuts" | "notifications" | "spamProtection" | "promotions" | "remoteContent" | "cleanup" | "autoReply";

const experienceSections = [
	{ key: "appearance", node: <AppearanceSettings /> },
	{ key: "readingLayout", node: <InboxReadingLayoutSettings /> },
	{ key: "threading", node: <InboxThreadingSettings /> },
	{ key: "addresses", node: <RecipientAddressSettings /> },
	{ key: "compose", node: <ComposeDefaultsSettings /> },
	{ key: "shortcuts", node: <InboxShortcutsSettings /> },
	{
		key: "notifications",
		node: (
			<>
				<BrowserNotificationSettings />
				<div className="mt-4">
					<PushNotificationSettings />
				</div>
			</>
		),
	},
] as const;

const handlingSections = [
	{ key: "spamProtection", node: <SpamFilterSettings /> },
	{ key: "promotions", node: <PromotionsSettings /> },
	{ key: "remoteContent", node: <RemoteContentSettings /> },
	{ key: "cleanup", node: <TrashRetentionSettings /> },
	{ key: "autoReply", node: <MailboxAutoReplyForm /> },
] as const;

export default async function SettingsInboxPage() {
	const t = await getServerTranslator();
	const renderSections = (sections: readonly { key: InboxSectionKey; node: React.ReactNode }[]) =>
		sections.map((section) => (
			<div key={section.key} className="py-6 first:pt-0 last:pb-0">
				<div className="mb-4">
					<h3 className="text-base font-semibold text-neutral-900">{t(`settingsPage.inbox.${section.key}`)}</h3>
					<p className="mt-1 text-sm text-neutral-500">{t(`settingsPage.inbox.${section.key}Description`)}</p>
				</div>
				{section.node}
			</div>
		));
	return (
		<div className="space-y-8 py-4">
			<h1 className="sr-only">{t("settings.nav.inbox")}</h1>
			<section className="space-y-4">
				<div>
					<h2 className="text-xl font-semibold text-neutral-900">{t("settingsPage.inbox.experience")}</h2>
					<p className="mt-1 text-sm text-neutral-500">{t("settingsPage.inbox.experienceDescription")}</p>
				</div>
				<div className="divide-y divide-neutral-100 rounded-3xl bg-white p-6">{renderSections(experienceSections)}</div>
			</section>
			<section className="space-y-4">
				<div>
					<h2 className="text-xl font-semibold text-neutral-900">{t("settingsPage.inbox.handling")}</h2>
					<p className="mt-1 text-sm text-neutral-500">{t("settingsPage.inbox.handlingDescription")}</p>
				</div>
				<div className="divide-y divide-neutral-100 rounded-3xl bg-white p-6">{renderSections(handlingSections)}</div>
			</section>
		</div>
	);
}
