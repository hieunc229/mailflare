"use client";

import { useId } from "react";
import { ChevronDown } from "@/components/icons";
import { locales, supportedLocales } from "@/lib/i18n/locales";
import { resolveLocale } from "@/lib/i18n/utils";
import { useLanguage } from "./language-provider";

export function LanguageSelector({ variant = "field" }: { variant?: "field" | "text" }) {
	const id = useId();
	const { locale, setLocale, t } = useLanguage();
	const options = supportedLocales.map((value) => (
		<option key={value} value={value} lang={value}>{locales[value].label}</option>
	));

	if (variant === "text") {
		// The select is invisible and stretched over a span showing the current label, so the width follows the selected value rather than the longest option.
		return (
			<div className="relative inline-flex items-center gap-1 rounded-md text-sm font-medium text-neutral-600 hover:text-neutral-950 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-blue-600">
				<span aria-hidden="true" className="py-2">{locales[locale].label}</span>
				<ChevronDown className="h-4 w-4" aria-hidden="true" />
				<select id={id} aria-label={t("language.label")} value={locale} onChange={(event) => setLocale(resolveLocale(event.target.value))} className="absolute inset-0 h-full w-full cursor-pointer opacity-0">
					{options}
				</select>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-1 px-1">
			<label htmlFor={id} className="text-xs text-neutral-600">{t("language.label")}</label>
			<select id={id} value={locale} onChange={(event) => setLocale(resolveLocale(event.target.value))} className="min-h-11 w-full rounded-lg border border-neutral-300 bg-white px-2 text-sm text-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600">
				{options}
			</select>
		</div>
	);
}
