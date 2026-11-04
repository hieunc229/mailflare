"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { LanguageSelector } from "@/components/language-selector";
import { Skeleton } from "@/components/ui/skeleton";
import { MailboxSignatureForm } from "./mailbox-signature-form";
import { ProfileForm } from "./profile-form";
import { TimeZoneForm } from "./time-zone-form";
import type { AccountSettingsResponse } from "./types";
import { loadAccountSettings } from "./utils";

export function AccountSettings() {
	const { t } = useLanguage();
	const [user, setUser] = useState<AccountSettingsResponse["user"]>();
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;

		loadAccountSettings()
			.then((nextUser) => {
				if (!cancelled) setUser(nextUser);
			})
			.catch((err) => {
				if (!cancelled) setError(err instanceof Error ? err.message : t("settings.account.loadFailed"));
			});

		return () => {
			cancelled = true;
		};
	}, [t]);

	if (error) {
		return <p role="alert" className="py-8 text-sm text-red-600">{error}</p>;
	}

	if (!user) {
		return (
			<div className="space-y-6 py-4">
				<Skeleton className="h-9 w-40" />
				<Skeleton className="h-72 w-full rounded-3xl" />
			</div>
		);
	}

	return (
		<div className="space-y-8 py-4">
			<h1 className="sr-only">{t("settings.nav.account")}</h1>
			{/* <div>
				<h1 className="text-2xl md:text-3xl font-medium text-neutral-900">Account</h1>
				<p className="mt-1 text-sm text-neutral-500">Manage your account details and sign-in password.</p>
			</div> */}

			<section className="space-y-4">
				<div>
					<h2 className="text-xl font-semibold text-neutral-900">{t("settings.account.detailsTitle")}</h2>
					<p className="mt-1 text-sm text-neutral-500">{t("settings.account.detailsDescription")}</p>
				</div>
				<div className="space-y-1 overflow-hidden rounded-3xl">
					<ProfileForm
						accountName={user.name}
						initialResetEmail={user.resetEmail ?? ""}
					/>

					<div className="space-y-4 rounded-b-3xl rounded-t-lg bg-white p-6">
						<div>
							<h3 className="text-lg font-semibold text-neutral-900">{t("settings.account.signatureTitle")}</h3>
							<p className="mt-1 text-sm text-neutral-500">{t("settings.account.signatureDescription")}</p>
						</div>
					<MailboxSignatureForm />
					</div>
				</div>
			</section>

			<section className="space-y-4">
				<div>
					<h2 className="text-xl font-semibold text-neutral-900">{t("settings.account.generalTitle")}</h2>
					<p className="mt-1 text-sm text-neutral-500">{t("settings.account.generalDescription")}</p>
				</div>
				<div className="space-y-1 overflow-hidden rounded-3xl">
					<div className="rounded-t-3xl rounded-b-lg bg-white p-6">
						<h3 className="mb-3 text-lg font-semibold text-neutral-900">{t("language.label")}</h3>
						<div className="max-w-xs [&>div]:px-0 [&_label]:sr-only"><LanguageSelector /></div>
					</div>
					<TimeZoneForm userId={user.id} initialTimeZone={user.timeZone} />
				</div>
			</section>
		</div>
	);
}
