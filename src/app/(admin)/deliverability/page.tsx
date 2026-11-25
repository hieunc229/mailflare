"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
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
	const [domainsFailed, setDomainsFailed] = useState(false);
	const [settingsFailed, setSettingsFailed] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const [tab, setTab] = useState<Tab>("reports");

	// Domains and settings load independently: a failing settings endpoint must not hide the domain tabs.
	useEffect(() => {
		let active = true;
		void Promise.allSettled([fetchDomains(), fetchSettings()]).then(([list, loaded]) => {
			if (!active) return;
			if (list.status === "fulfilled") {
				setDomainsFailed(false);
				setDomains(list.value);
				setDomainId((current) => current || list.value[0]?.id || "");
			} else setDomainsFailed(true);
			setSettingsFailed(loaded.status === "rejected");
			if (loaded.status === "fulfilled") setSettings(loaded.value);
		});
		return () => { active = false; };
	}, [attempt]);

	const retry = () => { setDomainsFailed(false); setSettingsFailed(false); setAttempt((value) => value + 1); };

	return <div className="space-y-6">
		<h1 className="text-2xl font-medium text-neutral-900 md:text-3xl">{t("deliverability.title")}</h1>
		{domainsFailed && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-red-700">
			<p>{t("accounts.domainsFailed")}</p>
			<Button type="button" variant="outline" size="sm" onClick={retry}>{t("webhooks.retry")}</Button>
		</div>}
		{!domains && !domainsFailed && <p role="status" className="text-sm text-neutral-500">{t("deliverability.loading")}</p>}
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
				{!settings && settingsFailed && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-red-700">
					<p>{t("general.loadFailed")}</p>
					<Button type="button" variant="outline" size="sm" onClick={retry}>{t("webhooks.retry")}</Button>
				</div>}
				<SuppressionList key={domainId} domainId={domainId} />
			</div>}
		</>}
	</div>;
}
