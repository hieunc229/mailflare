"use client";

import { useId } from "react";
import { locales, supportedLocales } from "@/lib/i18n/locales";
import { resolveLocale } from "@/lib/i18n/utils";
import { useLanguage } from "./language-provider";
import { Select } from "@/components/ui/select";

export function LanguageSelector({ variant = "field" }: { variant?: "field" | "text" }) {
	const id = useId();
	const { locale, setLocale, t } = useLanguage();
	const options = supportedLocales.map((value) => (
		<option key={value} value={value} lang={value}>{locales[value].label}</option>
	));

	if (variant === "text") {
		return (
			<Select id={id} aria-label={t("language.label")} value={locale} onChange={(event) => setLocale(resolveLocale(event.target.value))} containerClassName="contents" className="w-auto gap-1 rounded-md py-2 text-sm font-medium text-neutral-600 hover:text-neutral-950">
				{options}
			</Select>
		);
	}

	return (
		<div className="flex flex-col gap-1 px-1">
			<label htmlFor={id} className="text-xs text-neutral-600">{t("language.label")}</label>
			<Select id={id} value={locale} onChange={(event) => setLocale(resolveLocale(event.target.value))} containerClassName="w-full rounded-lg border-neutral-300 bg-white" className="min-h-11 text-sm text-neutral-800">
				{options}
			</Select>
		</div>
	);
}
