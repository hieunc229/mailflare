"use client";

import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { SpamKeySource } from "@/lib/spam/types";
import type { SpamFilterSettingsResponse, SpamKeyField } from "./types";
import { ABUSECH_SIGNUP_URL, formatBrandLines, loadSpamFilterSettings, parseBrandLines, saveSpamFilterSettings, SPAMHAUS_SIGNUP_URL } from "./utils";

/** Admin settings for the spam filter's external lookups and the installation's own brand list. */
export default function SpamFilterSettingsPage() {
	const { t } = useLanguage();
	const [settings, setSettings] = useState<SpamFilterSettingsResponse | null>(null);
	const [loadError, setLoadError] = useState("");
	const [brandText, setBrandText] = useState("");
	const [brandStatus, setBrandStatus] = useState("");
	const [brandSaving, setBrandSaving] = useState(false);
	const [ageSaving, setAgeSaving] = useState(false);
	const [ageStatus, setAgeStatus] = useState("");

	useEffect(() => {
		let active = true;
		void loadSpamFilterSettings().then((data) => {
			if (!active) return;
			setSettings(data);
			setBrandText(formatBrandLines(data.brands));
		}).catch((error) => { if (active) setLoadError(error instanceof Error ? error.message : t("spamFilter.loadFailed")); });
		return () => { active = false; };
	}, [t]);

	const editable = Boolean(settings?.available);
	const parsedBrands = parseBrandLines(brandText);

	async function saveBrands(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (parsedBrands.invalidLines.length) return;
		setBrandSaving(true);
		setBrandStatus("");
		try {
			const data = await saveSpamFilterSettings({ brands: parsedBrands.brands });
			setSettings(data);
			setBrandText(formatBrandLines(data.brands));
			setBrandStatus(t("spamFilter.saved"));
		} catch (error) {
			setBrandStatus(error instanceof Error ? error.message : t("spamFilter.saveFailed"));
		} finally { setBrandSaving(false); }
	}

	function toggleDomainAge(checked: boolean) {
		setAgeSaving(true);
		setAgeStatus("");
		void saveSpamFilterSettings({ domainAge: checked })
			.then(setSettings)
			.catch((error) => setAgeStatus(error instanceof Error ? error.message : t("spamFilter.saveFailed")))
			.finally(() => setAgeSaving(false));
	}

	return <div className="space-y-6">
		<div><h1 className="text-2xl md:text-3xl font-medium text-neutral-900">{t("spamFilter.title")}</h1><p className="mt-2 text-sm text-neutral-500">{t("spamFilter.description")}</p></div>
		{loadError && <p role="alert" className="text-sm text-red-700">{loadError}</p>}
		{settings && !settings.available && <p role="status" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-800">{t("spamFilter.needsUpdate")}</p>}

		<Card className="rounded-3xl border-0 bg-white p-6">
			<CardHeader className="py-0"><CardTitle>{t("spamFilter.blocklists")}</CardTitle><CardDescription>{t("spamFilter.blocklistsHint")}</CardDescription></CardHeader>
			<CardContent className="space-y-6 pt-6">
				<KeyRow field="spamhausDqsKey" envName="SPAMHAUS_DQS_KEY" title={t("spamFilter.spamhaus")} hint={t("spamFilter.spamhausHint")} signupUrl={SPAMHAUS_SIGNUP_URL} source={settings?.spamhaus.source ?? null} disabled={!editable} onSaved={setSettings} />
				<KeyRow field="abuseChAuthKey" envName="ABUSECH_AUTH_KEY" title={t("spamFilter.abusech")} hint={t("spamFilter.abusechHint")} signupUrl={ABUSECH_SIGNUP_URL} source={settings?.abusech.source ?? null} disabled={!editable} onSaved={setSettings} />
			</CardContent>
		</Card>

		<Card className="rounded-3xl border-0 bg-white p-6">
			<CardContent className="flex items-center justify-between gap-4 p-0">
				<div><p className="font-medium text-neutral-900">{t("spamFilter.domainAge")}</p><p className="mt-1 text-sm text-neutral-500">{t("spamFilter.domainAgeHint")}</p>{settings?.domainAgeForcedOff && <p className="mt-1 text-sm text-amber-700">{t("spamFilter.domainAgeForcedOff")}</p>}</div>
				<Switch checked={Boolean(settings?.domainAge && !settings.domainAgeForcedOff)} disabled={!editable || ageSaving || settings?.domainAgeForcedOff} onCheckedChange={toggleDomainAge} aria-label={t("spamFilter.domainAge")} />
			</CardContent>
			{ageStatus && <p role="status" className="mt-3 text-sm text-red-700">{ageStatus}</p>}
		</Card>

		<Card className="rounded-3xl border-0 bg-white p-6">
			<CardHeader className="py-0"><CardTitle>{t("spamFilter.brands")}</CardTitle><CardDescription>{t("spamFilter.brandsHint")}</CardDescription></CardHeader>
			<CardContent className="pt-6"><form onSubmit={saveBrands} className="space-y-4">
				<div className="space-y-2">
					<Label htmlFor="spam-brands">{t("spamFilter.brandsLabel")}</Label>
					<Textarea id="spam-brands" rows={6} value={brandText} onChange={(event) => setBrandText(event.target.value)} disabled={!editable || brandSaving} placeholder={"PostFinance = postfinance.ch\nSwisscom = swisscom.ch, swisscom.com"} className="font-mono text-sm" aria-describedby="spam-brands-help" />
					<p id="spam-brands-help" className="text-xs text-neutral-500">{t("spamFilter.brandsBuiltIn")}</p>
					{parsedBrands.invalidLines.length > 0 && <p role="alert" className="text-sm text-red-700">{t("spamFilter.brandsInvalid", { lines: parsedBrands.invalidLines.join(", ") })}</p>}
				</div>
				{brandStatus && <p role="status" className="text-sm text-neutral-700">{brandStatus}</p>}
				<Button type="submit" disabled={!editable || brandSaving || parsedBrands.invalidLines.length > 0}>{brandSaving ? t("common.saving") : t("spamFilter.saveBrands")}</Button>
			</form></CardContent>
		</Card>
	</div>;
}

function KeyRow({ field, envName, title, hint, signupUrl, source, disabled, onSaved }: {
	field: SpamKeyField;
	envName: string;
	title: string;
	hint: string;
	signupUrl: string;
	source: SpamKeySource;
	disabled: boolean;
	onSaved: (settings: SpamFilterSettingsResponse) => void;
}) {
	const { t } = useLanguage();
	const [value, setValue] = useState("");
	const [saving, setSaving] = useState(false);
	const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
	const inputId = `spam-key-${field}`;

	async function save(key: string | null) {
		setSaving(true);
		setStatus(null);
		try {
			onSaved(await saveSpamFilterSettings({ [field]: key }));
			setValue("");
			setStatus({ text: key ? t("spamFilter.keySavedStatus") : t("spamFilter.keyRemovedStatus"), error: false });
		} catch (error) {
			setStatus({ text: error instanceof Error ? error.message : t("spamFilter.saveFailed"), error: true });
		} finally { setSaving(false); }
	}

	const sourceText = source === "settings" ? t("spamFilter.keySaved") : source === "env" ? t("spamFilter.keyFromEnv", { name: envName }) : t("spamFilter.keyMissing");
	return <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); if (value.trim()) void save(value.trim()); }}>
		<div className="flex flex-wrap items-baseline justify-between gap-2">
			<Label htmlFor={inputId} className="font-medium">{title}</Label>
			<a href={signupUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-blue-700 hover:underline">{t("spamFilter.getKey")}<ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /></a>
		</div>
		<p className="text-sm text-neutral-500">{hint}</p>
		<p className={source ? "text-sm text-green-700" : "text-sm text-neutral-500"}>{sourceText}</p>
		<div className="flex flex-wrap gap-2">
			<Input id={inputId} type="password" autoComplete="off" spellCheck={false} value={value} onChange={(event) => setValue(event.target.value)} disabled={disabled || saving} placeholder={source ? t("spamFilter.keyReplacePlaceholder") : t("spamFilter.keyPlaceholder")} className="max-w-md flex-1" />
			<Button type="submit" disabled={disabled || saving || !value.trim()}>{saving ? t("common.saving") : t("spamFilter.saveKey")}</Button>
			{source === "settings" && <Button type="button" variant="outline" disabled={disabled || saving} onClick={() => void save(null)}>{t("spamFilter.removeKey")}</Button>}
		</div>
		{status && <p role={status.error ? "alert" : "status"} className={status.error ? "text-sm text-red-700" : "text-sm text-neutral-700"}>{status.text}</p>}
	</form>;
}
