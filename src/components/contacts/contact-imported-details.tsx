"use client";

import { useLanguage } from "@/components/language-provider";
import { formatBirthday } from "@/lib/contacts/details-utils";
import type { ContactImportedDetailsProps } from "./contact-details-types";

/** Phones, addresses and so on from a contact import, read only. Everything is shown as plain text. */
export function ContactImportedDetails({ details, address }: ContactImportedDetailsProps) {
	const { t, locale } = useLanguage();
	const others = (details?.emails ?? []).filter((email) => email.toLowerCase() !== address.toLowerCase());
	const work = [details?.organization, details?.title].filter(Boolean).join(" · ");
	const phones = details?.phones ?? [];
	const addresses = details?.addresses ?? [];
	if (!work && !phones.length && !addresses.length && !details?.birthday && !details?.note && !others.length) return null;

	const row = (label: string, children: React.ReactNode, className = "") => (
		<div className={`min-w-0 ${className}`.trim()}>
			<dt className="text-xs font-medium uppercase text-neutral-500">{label}</dt>
			<dd className="mt-1 space-y-1 break-words text-neutral-700">{children}</dd>
		</div>
	);
	const typed = (type: string, text: string) => (
		<p key={`${type}:${text}`}>
			{text}
			{type && <span className="ml-2 text-xs text-neutral-500">{type}</span>}
		</p>
	);

	return (
		<dl className="grid gap-3 rounded-lg bg-neutral-50 p-3 text-sm sm:grid-cols-2">
			{work && row(t("contact.organization"), <p>{work}</p>)}
			{details?.birthday && row(t("contact.birthday"), <p>{formatBirthday(details.birthday, locale)}</p>)}
			{phones.length > 0 && row(t("contact.phones"), phones.map((phone) => typed(phone.type, phone.value)))}
			{others.length > 0 && row(t("contact.otherEmails"), others.map((email) => <p key={email}>{email}</p>))}
			{addresses.length > 0 && row(t("contact.addresses"), addresses.map((item) => typed(item.type, item.formatted)))}
			{details?.note && row(t("contact.note"), <p className="whitespace-pre-wrap">{details.note}</p>, "sm:col-span-2")}
		</dl>
	);
}
