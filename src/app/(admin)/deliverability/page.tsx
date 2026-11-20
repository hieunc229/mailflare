"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Select } from "@/components/ui/select";
import { DmarcTab } from "./DmarcTab";
import { MtaStsTab } from "./MtaStsTab";
import { SettingsPanel } from "./SettingsPanel";
import { SuppressionList } from "./SuppressionList";
import { TlsTab } from "./TlsTab";
import type { DeliverabilitySettings, DomainOption } from "./types";
import { fetchDomains, fetchSettings } from "./utils";

type Tab = "reports" | "tls" | "mtasts" | "suppressions";
const TABS: Tab[] = ["reports", "tls", "mtasts", "suppressions"];

export default function DeliverabilityPage() {
	const { t } = useLanguage();
	const [domains, setDomains] = useState<DomainOption[] | null>(null);
	const [domainId, setDomainId] = useState("");
	const [settings, setSettings] = useState<DeliverabilitySettings | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [tab, setTab] = useState<Tab>("reports");

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
		<h1 className="text-2xl font-medium text-neutral-900 md:text-3xl">{t("deliverability.title")}</h1>
		{error && <p role="alert" className="text-sm text-red-700">{error}</p>}
		{!domains && !error && <p className="text-sm text-neutral-500">{t("deliverability.loading")}</p>}
		{domains?.length === 0 && <p className="text-sm text-neutral-500">{t("deliverability.noDomains")}</p>}
		{domains && domains.length > 0 && <>
			<div className="space-y-2">
				<label htmlFor="deliverability-domain" className="block text-sm font-semibold text-neutral-900">{t("deliverability.domain")}</label>
				<Select id="deliverability-domain" value={domainId} containerClassName="w-full sm:w-64" className="h-10 text-sm" onChange={(event) => setDomainId(event.target.value)}>
					{domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.hostname}</option>)}
				</Select>
			</div>
			<div role="tablist" aria-label={t("dmarc.tabs.label")} className="flex gap-2 border-b border-neutral-200" onKeyDown={(event) => {
				if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
				const next = TABS[(TABS.indexOf(tab) + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
				setTab(next);
				document.getElementById(`deliverability-tab-${next}`)?.focus();
			}}>
				{TABS.map((id) => <button key={id} id={`deliverability-tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`deliverability-panel-${id}`} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)} className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${tab === id ? "border-blue-600 text-blue-700" : "border-transparent text-neutral-600 hover:text-neutral-900"}`}>{t(`dmarc.tab.${id}`)}</button>)}
			</div>
			{tab === "reports" && domainId && <div role="tabpanel" id="deliverability-panel-reports" aria-labelledby="deliverability-tab-reports"><DmarcTab key={domainId} domainId={domainId} /></div>}
			{tab === "tls" && domainId && <div role="tabpanel" id="deliverability-panel-tls" aria-labelledby="deliverability-tab-tls"><TlsTab key={domainId} domainId={domainId} /></div>}
			{tab === "mtasts" && domainId && <div role="tabpanel" id="deliverability-panel-mtasts" aria-labelledby="deliverability-tab-mtasts"><MtaStsTab key={domainId} domainId={domainId} /></div>}
			{tab === "suppressions" && domainId && <div role="tabpanel" id="deliverability-panel-suppressions" aria-labelledby="deliverability-tab-suppressions" className="space-y-6">
				<p className="text-sm text-neutral-500">{t("deliverability.description")}</p>
				{settings && <SettingsPanel settings={settings} onChange={setSettings} />}
				<SuppressionList key={domainId} domainId={domainId} />
			</div>}
		</>}
	</div>;
}
