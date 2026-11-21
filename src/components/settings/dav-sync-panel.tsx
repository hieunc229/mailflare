"use client";

import Link from "next/link";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Field } from "./app-password-field";
import type { DavStatus } from "./app-passwords-types";
import { davConnectionUrls } from "./app-passwords-utils";

type Props = {
	dav: DavStatus;
	origin: string;
	/** Whether the user already holds an app password that carries calendar and contacts access. */
	hasPassword: boolean;
	onCreate: () => void;
	onCopy: (id: string, label: string, value: string) => void;
	copied: string | null;
};

const CLIENTS = ["ios", "davx5", "thunderbird"] as const;

/**
 * Calendar and contacts sync on the App passwords page: explains an off
 * switch, shows the addresses to paste into a phone or computer, and how to
 * set up the common apps. It shows addresses only; the password itself appears
 * once, when it is created.
 */
export function DavSyncPanel({ dav, origin, hasPassword, onCreate, onCopy, copied }: Props) {
	const { t } = useLanguage();
	const urls = origin ? davConnectionUrls(origin, dav.userId) : null;
	// iOS and macOS only take these accounts over TLS; this machine is the one exception.
	const insecure = !!urls && new URL(origin).protocol === "http:" && !["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
	return (
		<section aria-labelledby="dav-sync-title" className="space-y-3 rounded-2xl bg-neutral-50 p-4">
			<h2 id="dav-sync-title" className="text-sm font-semibold text-neutral-900">{t("appPasswords.dav.title")}</h2>
			{!dav.enabled ? (
				<div className="space-y-2 text-sm text-neutral-600">
					<p>{t("appPasswords.dav.off")}</p>
					{dav.isAdmin && (
						<p>
							{t("appPasswords.dav.offAdmin")}{" "}
							<Link href="/general" className="font-medium text-blue-700 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">{t("appPasswords.dav.openAdmin")}</Link>
						</p>
					)}
				</div>
			) : (
				<>
					<p className="text-sm text-neutral-600">{t("appPasswords.dav.intro")}</p>
					{!dav.calendarEnabled && <p className="text-sm text-amber-700">{t("appPasswords.dav.noCalendar")}</p>}
					{insecure && <p className="text-sm text-amber-700">{t("appPasswords.dav.needsHttps")}</p>}
					{urls && (
						<div className="space-y-3">
							<Field id="dav-base" label={t("appPasswords.dav.baseUrl")} value={urls.base} onCopy={onCopy} copied={copied} />
							<Field id="dav-username" label={t("emailClients.username")} value={dav.email} onCopy={onCopy} copied={copied} />
							<Field id="dav-caldav" label={t("appPasswords.dav.caldavUrl")} value={urls.caldav} onCopy={onCopy} copied={copied} />
							<Field id="dav-carddav" label={t("appPasswords.dav.carddavUrl")} value={urls.carddav} onCopy={onCopy} copied={copied} />
						</div>
					)}
					{!hasPassword && (
						<div className="flex flex-wrap items-center gap-3 text-sm text-neutral-600">
							<p>{t("appPasswords.dav.noPassword")}</p>
							<Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-0" onClick={onCreate}>{t("appPasswords.dav.createOne")}</Button>
						</div>
					)}
					<h3 className="pt-1 text-sm font-medium text-neutral-900">{t("appPasswords.dav.clients")}</h3>
					<div className="space-y-2">
						{CLIENTS.map((client) => (
							<details key={client} className="rounded-xl bg-white px-3 py-2">
								<summary className="cursor-pointer rounded-md py-1 text-sm font-medium text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">{t(`appPasswords.dav.${client}.title` as "appPasswords.dav.ios.title")}</summary>
								<ol className="mt-2 list-decimal space-y-1 ps-5 text-sm text-neutral-600">
									<li>{t(`appPasswords.dav.${client}.step1` as "appPasswords.dav.ios.step1")}</li>
									<li>{t(`appPasswords.dav.${client}.step2` as "appPasswords.dav.ios.step2")}</li>
								</ol>
							</details>
						))}
					</div>
				</>
			)}
		</section>
	);
}
