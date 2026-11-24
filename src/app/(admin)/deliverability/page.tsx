"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Select } from "@/components/ui/select";
import { SettingsPanel } from "./SettingsPanel";
import { SuppressionList } from "./SuppressionList";
import type { DeliverabilitySettings, DomainOption } from "./types";
import { fetchDomains, fetchSettings } from "./utils";

export default function DeliverabilityPage() {
	const { t } = useLanguage();
	const [domains, setDomains] = useState<DomainOption[] | null>(null);
	const [domainId, setDomainId] = useState("");
	const [settings, setSettings] = useState<DeliverabilitySettings | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		void Promise.all([fetchDomains(), fetchSettings()]).then(([list, loaded]) => {
			if (!active) return;
			setDomains(list);
			setDomainId((current) => current || list[0]?.id || "");
			setSettings(loaded);
		}).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : t("deliverability.loadFailed")); });
		return () => { active = false; };
	}, [t]);

	return <div className="space-y-6">
		<div><h1 className="text-2xl font-medium text-neutral-900 md:text-3xl">{t("deliverability.title")}</h1><p className="mt-2 text-sm text-neutral-500">{t("deliverability.description")}</p></div>
		{error && <p role="alert" className="text-sm text-red-700">{error}</p>}
		{!domains && !error && <p className="text-sm text-neutral-500">{t("deliverability.loading")}</p>}
		{settings && <SettingsPanel settings={settings} onChange={setSettings} />}
		{domains?.length === 0 && <p className="text-sm text-neutral-500">{t("deliverability.noDomains")}</p>}
		{domains && domains.length > 0 && <>
			<div className="space-y-2">
				<label htmlFor="deliverability-domain" className="block text-sm font-semibold text-neutral-900">{t("deliverability.domain")}</label>
				<Select id="deliverability-domain" value={domainId} containerClassName="w-full sm:w-64" className="h-10 text-sm" onChange={(event) => setDomainId(event.target.value)}>
					{domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.hostname}</option>)}
				</Select>
			</div>
			{domainId && <SuppressionList key={domainId} domainId={domainId} />}
		</>}
	</div>;
}
