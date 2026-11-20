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

export default async function SettingsInboxPage() {
	const t = await getServerTranslator();
	return (
		<div className="space-y-8 py-4">
			<h1 className="sr-only">{t("settings.nav.inbox")}</h1>
			<section className="space-y-4">
				<div>
					<h2 className="text-xl font-semibold text-neutral-900">{t("settingsPage.inbox.experience")}</h2>
					<p className="mt-1 text-sm text-neutral-500">{t("settingsPage.inbox.experienceDescription")}</p>
				</div>
				<div className="divide-y divide-neutral-100 rounded-3xl bg-white p-6">
					<div className="py-6 first:pt-0 last:pb-0">
						<div className="mb-4">
							<h3 className="text-base font-semibold text-neutral-900">{t("settingsPage.inbox.appearance")}</h3>
							<p className="mt-1 text-sm text-neutral-500">{t("settingsPage.inbox.appearanceDescription")}</p>
						</div>
						<AppearanceSettings />
					</div>
					<div className="py-6 first:pt-0 last:pb-0">
						<div className="mb-4">
							<h3 className="text-base font-semibold text-neutral-900">{t("settingsPage.inbox.readingLayout")}</h3>
							<p className="mt-1 text-sm text-neutral-500">{t("settingsPage.inbox.readingLayoutDescription")}</p>
						</div>
						<InboxReadingLayoutSettings />
					</div>
					<div className="py-6 first:pt-0 last:pb-0">
						<div className="mb-4">
							<h3 className="text-base font-semibold text-neutral-900">{t("settingsPage.inbox.threading")}</h3>
							<p className="mt-1 text-sm text-neutral-500">{t("settingsPage.inbox.threadingDescription")}</p>
						</div>
						<InboxThreadingSettings />
					</div>
					<div className="py-6 first:pt-0 last:pb-0">
						<div className="mb-4">
							<h3 className="text-base font-semibold text-neutral-900">{t("settingsPage.inbox.addresses")}</h3>
							<p className="mt-1 text-sm text-neutral-500">{t("settingsPage.inbox.addressesDescription")}</p>
						</div>
						<RecipientAddressSettings />
					</div>
					<div className="py-6 first:pt-0 last:pb-0">
						<div className="mb-4">
							<h3 className="text-base font-semibold text-neutral-900">{t("settingsPage.inbox.compose")}</h3>
							<p className="mt-1 text-sm text-neutral-500">{t("settingsPage.inbox.composeDescription")}</p>
						</div>
						<ComposeDefaultsSettings />
					</div>
					<div className="py-6 first:pt-0 last:pb-0">
						<div className="mb-4">
							<h3 className="text-base font-semibold text-neutral-900">{t("settingsPage.inbox.shortcuts")}</h3>
							<p className="mt-1 text-sm text-neutral-500">{t("settingsPage.inbox.shortcutsDescription")}</p>
						</div>
						<InboxShortcutsSettings />
					</div>
					<div className="py-6 first:pt-0 last:pb-0">
						<div className="mb-4">
							<h3 className="text-base font-semibold text-neutral-900">{t("settingsPage.inbox.notifications")}</h3>
							<p className="mt-1 text-sm text-neutral-500">{t("settingsPage.inbox.notificationsDescription")}</p>
						</div>
						<BrowserNotificationSettings />
						<div className="mt-4">
							<PushNotificationSettings />
						</div>
					</div>
				</div>
			</section>
			<section className="space-y-4">
				<div>
					<h2 className="text-xl font-semibold text-neutral-900">{t("settingsPage.inbox.handling")}</h2>
					<p className="mt-1 text-sm text-neutral-500">{t("settingsPage.inbox.handlingDescription")}</p>
				</div>
				<div className="divide-y divide-neutral-100 rounded-3xl bg-white p-6">
					<div className="py-6 first:pt-0 last:pb-0">
						<div className="mb-4">
							<h3 className="text-base font-semibold text-neutral-900">{t("settingsPage.inbox.spamProtection")}</h3>
							<p className="mt-1 text-sm text-neutral-500">{t("settingsPage.inbox.spamProtectionDescription")}</p>
						</div>
						<SpamFilterSettings />
					</div>
					<div className="py-6 first:pt-0 last:pb-0">
						<div className="mb-4">
							<h3 className="text-base font-semibold text-neutral-900">{t("settingsPage.inbox.promotions")}</h3>
							<p className="mt-1 text-sm text-neutral-500">{t("settingsPage.inbox.promotionsDescription")}</p>
						</div>
						<PromotionsSettings />
					</div>
					<div className="py-6 first:pt-0 last:pb-0">
						<div className="mb-4">
							<h3 className="text-base font-semibold text-neutral-900">{t("settingsPage.inbox.remoteContent")}</h3>
							<p className="mt-1 text-sm text-neutral-500">{t("settingsPage.inbox.remoteContentDescription")}</p>
						</div>
						<RemoteContentSettings />
					</div>
					<div className="py-6 first:pt-0 last:pb-0">
						<div className="mb-4">
							<h3 className="text-base font-semibold text-neutral-900">{t("settingsPage.inbox.cleanup")}</h3>
							<p className="mt-1 text-sm text-neutral-500">{t("settingsPage.inbox.cleanupDescription")}</p>
						</div>
						<TrashRetentionSettings />
					</div>
					<div className="py-6 first:pt-0 last:pb-0">
						<div className="mb-4">
							<h3 className="text-base font-semibold text-neutral-900">{t("settingsPage.inbox.autoReply")}</h3>
							<p className="mt-1 text-sm text-neutral-500">
								{t("settingsPage.inbox.autoReplyDescription")}
							</p>
						</div>
						<MailboxAutoReplyForm />
					</div>
				</div>
			</section>
		</div>
	);
}
