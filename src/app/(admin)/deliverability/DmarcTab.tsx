"use client";

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select } from "@/components/ui/select";
import { DmarcChart } from "./DmarcChart";
import { DmarcRecordPreviewDialog } from "./DmarcRecordPreviewDialog";
import { DmarcTables } from "./DmarcTables";
import type { DmarcOverview, DmarcRange, DmarcStats, OpenAlert } from "./types";
import { errorKey } from "./dmarc-utils";
import { acknowledgeAlert, fetchDmarc, fetchOverview, formatEventDate, putReports } from "./utils";

function AlertList({ alerts, onAcknowledge }: { alerts: OpenAlert[]; onAcknowledge: (id: string) => void }) {
	const { t } = useLanguage();
	return <section aria-labelledby="dmarc-alerts" className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50 p-5">
		<h3 id="dmarc-alerts" className="text-sm font-semibold text-amber-950">{t("dmarc.alerts.title")}</h3>
		<ul className="space-y-3">
			{alerts.map((alert) => {
				const sources = alert.detail.sources ?? [];
				return <li key={alert.id} className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
					<div className="space-y-1 text-sm text-amber-950">
						<p className="font-medium">{t(`dmarc.alert.${alert.kind}`)} <span className="font-normal text-amber-800">({t("dmarc.alert.day", { day: alert.day })})</span></p>
						{sources.length > 0 && <ul className="font-mono text-xs">{sources.map((source, index) => <li key={`${source.reporter ?? ""}|${source.sourceIp}|${index}`}>{t("dmarc.alert.source", { ip: source.sourceIp, failed: source.failed, messages: source.messages })}</li>)}</ul>}
						{(alert.detail.total ?? 0) > sources.length && <p className="text-xs">{t("dmarc.alert.more", { count: (alert.detail.total ?? 0) - sources.length })}</p>}
					</div>
					<Button type="button" variant="outline" size="sm" onClick={() => onAcknowledge(alert.id)}>{t("dmarc.alert.acknowledge")}</Button>
				</li>;
			})}
		</ul>
	</section>;
}

export function DmarcTab({ domainId }: { domainId: string }) {
	const { t } = useLanguage();
	const [overview, setOverview] = useState<DmarcOverview | null>(null);
	const [stats, setStats] = useState<DmarcStats | null>(null);
	const [days, setDays] = useState<DmarcRange>(30);
	const [error, setError] = useState<string | null>(null);
	const [dialog, setDialog] = useState<"on" | "off" | null>(null);

	const describe = useCallback((cause: unknown, fallback: string) => {
		const key = errorKey((cause as { code?: string }).code);
		return key ? t(key) : fallback;
	}, [t]);

	const loadOverview = useCallback(async () => {
		try {
			setOverview(await fetchOverview(domainId));
		} catch (cause) {
			setError(describe(cause, t("dmarc.loadFailed")));
		}
	}, [domainId, describe, t]);

	// Deferred a tick, like the suppression list: the effect itself must not set state synchronously.
	useEffect(() => {
		const timer = setTimeout(() => void loadOverview(), 0);
		return () => clearTimeout(timer);
	}, [loadOverview]);

	useEffect(() => {
		let active = true;
		void fetchDmarc(domainId, days).then((loaded) => { if (active) setStats(loaded); }).catch((cause) => { if (active) setError(describe(cause, t("dmarc.loadFailed"))); });
		return () => { active = false; };
	}, [domainId, days, describe, t]);

	async function toggleAlertEmail(alertEmail: boolean) {
		setError(null);
		try {
			await putReports(domainId, { alertEmail });
			await loadOverview();
		} catch (cause) {
			setError(describe(cause, t("dmarc.alertEmail.failed")));
		}
	}

	async function acknowledge(alertId: string) {
		setError(null);
		try {
			await acknowledgeAlert(domainId, alertId);
			await loadOverview();
		} catch {
			setError(t("dmarc.alert.acknowledgeFailed"));
		}
	}

	const dns = overview?.dns;
	return <div className="space-y-6">
		<p className="text-sm text-neutral-500">{t("dmarc.description")}</p>
		{error && <p role="alert" className="text-sm text-red-700">{error}</p>}
		{overview && <section className="space-y-4 rounded-2xl bg-white p-5">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="text-sm font-semibold text-neutral-900">{t(overview.enabled ? "dmarc.status.on" : "dmarc.status.off")}</p>
				<Button type="button" variant={overview.enabled ? "outline" : "default"} size="sm" onClick={() => setDialog(overview.enabled ? "off" : "on")}>{t(overview.enabled ? "dmarc.turnOff" : "dmarc.turnOn")}</Button>
			</div>
			<dl className="grid gap-3 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-6">
				<dt className="text-neutral-500">{t("dmarc.address")}</dt><dd className="break-all font-mono text-xs">{overview.address}</dd>
				<dt className="text-neutral-500">{t("dmarc.lastReport")}</dt><dd>{overview.lastReportAt ? formatEventDate(overview.lastReportAt) : t("dmarc.lastReport.none")}</dd>
				<dt className="text-neutral-500">{t("dmarc.dns.label")}</dt><dd>{dns && "error" in dns ? t("dmarc.dns.unknown") : dns?.hasAddress ? t("dmarc.dns.present") : t("dmarc.dns.missing")}</dd>
			</dl>
			<label className="flex items-center gap-2 text-sm text-neutral-800"><Checkbox checked={overview.alertEmail} onChange={(event) => void toggleAlertEmail(event.target.checked)} />{t("dmarc.alertEmail")}</label>
		</section>}
		{overview && overview.alerts.length > 0 && <AlertList alerts={overview.alerts} onAcknowledge={(id) => void acknowledge(id)} />}
		<div className="flex flex-col gap-4 sm:flex-row sm:items-end">
			<div className="space-y-2">
				<label htmlFor="dmarc-range" className="block text-sm font-semibold text-neutral-900">{t("dmarc.range.label")}</label>
				<Select id="dmarc-range" value={String(days)} containerClassName="w-full sm:w-48" className="h-10 text-sm" onChange={(event) => setDays(Number(event.target.value) as DmarcRange)}>
					{[7, 30, 90].map((option) => <option key={option} value={option}>{t("dmarc.range.option", { days: option })}</option>)}
				</Select>
			</div>
		</div>
		{!stats && !error && <p role="status" className="text-sm text-neutral-500">{t("deliverability.loading")}</p>}
		{stats && stats.unverifiedReports > 0 && <p role="status" className="text-sm text-amber-900">{t("dmarc.unverified.note", { count: stats.unverifiedReports })}</p>}
		{stats && <div aria-busy={stats.days !== days} className="space-y-6">
			<DmarcChart series={stats.series} />
			<DmarcTables stats={stats} />
		</div>}
		{dialog && <DmarcRecordPreviewDialog domainId={domainId} enable={dialog === "on"} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void loadOverview(); }} />}
	</div>;
}
