"use client";

import { CustomSelect } from "@/components/ui/custom-select";

import { useId } from "react";
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
		return <CustomSelect id={id} aria-label={t("language.label")} value={locale} onChange={(event) => setLocale(resolveLocale(event.target.value))} className="inline-flex h-10 w-36 max-w-full items-center gap-2 rounded-md border-neutral-200 bg-white px-3 py-2 text-sm font-medium text-neutral-700 hover:text-neutral-950">{options}</CustomSelect>;
	}

	return (
		<div className="flex flex-col gap-1 px-1">
			<label htmlFor={id} className="text-xs text-neutral-600">{t("language.label")}</label>
			<CustomSelect id={id} value={locale} onChange={(event) => setLocale(resolveLocale(event.target.value))} className="min-h-11 w-full rounded-lg border border-neutral-300 bg-white px-2 text-sm text-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600">
				{options}
			</CustomSelect>
		</div>
	);
}
