"use client";

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { headClass, RecentReports, Table, Th } from "./DmarcTables";
import { tlsErrorKey, policyKey } from "./mta-sts-utils";
import type { DmarcRange, TlsOverview } from "./types";
import { fetchTls, putTlsRpt } from "./utils";

const cell = "px-4 py-3 text-right tabular-nums";

export function TlsTab({ domainId }: { domainId: string }) {
	const { t } = useLanguage();
	const [data, setData] = useState<TlsOverview | null>(null);
	const [days, setDays] = useState<DmarcRange>(30);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [manual, setManual] = useState<{ before: string | null; after: string | null; address: string } | null>(null);

	const describe = useCallback((cause: unknown, fallback: string) => {
		const key = tlsErrorKey((cause as { code?: string }).code);
		return key ? t(key) : fallback;
	}, [t]);

	// Deferred a tick, like the other tabs: the effect itself must not set state synchronously.
	useEffect(() => {
		let active = true;
		const timer = setTimeout(() => {
			void fetchTls(domainId, days).then((loaded) => { if (active) setData(loaded); }).catch((cause) => { if (active) setError(describe(cause, t("tls.loadFailed"))); });
		}, 0);
		return () => { active = false; clearTimeout(timer); };
	}, [domainId, days, describe, t]);

	async function toggle(enabled: boolean) {
		setBusy(true);
		setError(null);
		setManual(null);
		try {
			const { plan } = await putTlsRpt(domainId, enabled);
			if (plan.manual && plan.changed) setManual({ before: plan.before, after: plan.after, address: plan.address });
			setData(await fetchTls(domainId, days));
		} catch (cause) {
			setError(describe(cause, t("tls.failed")));
		} finally {
			setBusy(false);
		}
	}

	const dns = data?.dns;
	const stats = data?.stats;
	const dayRows = stats ? stats.series.filter((row) => row.success + row.failure > 0).reverse() : [];
	return <div className="space-y-6">
		<p className="text-sm text-neutral-500">{t("tls.description")}</p>
		{error && <p role="alert" className="text-sm text-red-700">{error}</p>}
		{data && <section className="space-y-4 rounded-2xl bg-white p-5">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="text-sm font-semibold text-neutral-900">{t(data.enabled ? "tls.status.on" : "tls.status.off")}</p>
				<Button type="button" variant={data.enabled ? "outline" : "default"} size="sm" disabled={busy || (!data.enabled && !data.reportsEnabled)} onClick={() => void toggle(!data.enabled)}>{t(data.enabled ? "tls.turnOff" : "tls.turnOn")}</Button>
			</div>
			{!data.enabled && !data.reportsEnabled && <p className="text-xs text-neutral-500">{t("tls.needsDmarc")}</p>}
			<dl className="grid gap-3 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-6">
				<dt className="text-neutral-500">{t("dmarc.address")}</dt><dd className="break-all font-mono text-xs">{data.address}</dd>
				<dt className="text-neutral-500">{t("dmarc.dns.label")}</dt><dd>{dns && "error" in dns ? t("tls.dns.unknown") : dns?.hasAddress ? t("tls.dns.present") : t("tls.dns.missing")}</dd>
			</dl>
			{manual && <p role="status" className="break-all rounded-lg bg-neutral-100 p-3 text-xs">{manual.after !== null ? t("tls.manual.set", { name: `_smtp._tls.${data.address.split("@")[1]}`, value: manual.after }) : t("tls.manual.unset", { name: `_smtp._tls.${data.address.split("@")[1]}`, address: manual.address })}</p>}
		</section>}
		<div className="space-y-2">
			<label htmlFor="tls-range" className="block text-sm font-semibold text-neutral-900">{t("dmarc.range.label")}</label>
			<Select id="tls-range" value={String(days)} containerClassName="w-full sm:w-48" className="h-10 text-sm" onChange={(event) => setDays(Number(event.target.value) as DmarcRange)}>
				{[7, 30, 90].map((option) => <option key={option} value={option}>{t("dmarc.range.option", { days: option })}</option>)}
			</Select>
		</div>
		{!data && !error && <p role="status" className="text-sm text-neutral-500">{t("deliverability.loading")}</p>}
		{stats && stats.unverifiedReports > 0 && <p role="status" className="text-sm text-amber-900">{t("tls.unverified.note", { count: stats.unverifiedReports })}</p>}
		{stats && <div aria-busy={stats.days !== days} className="space-y-6">
			<Table title={t("tls.daily.title")} minWidth="min-w-[420px]">
				<thead className={headClass}><tr><Th>{t("dmarc.col.day")}</Th><Th right>{t("tls.col.success")}</Th><Th right>{t("tls.col.failure")}</Th></tr></thead>
				<tbody className="divide-y divide-neutral-100">
					{dayRows.map((row) => <tr key={row.day}><td className="whitespace-nowrap px-4 py-3">{row.day}</td><td className={cell}>{row.success.toLocaleString()}</td><td className={cell}>{row.failure.toLocaleString()}</td></tr>)}
					{dayRows.length === 0 && <tr><td colSpan={3} className="px-4 py-8 text-center text-neutral-500">{t("tls.daily.empty")}</td></tr>}
				</tbody>
			</Table>
			<Table title={t("tls.failures.title")} minWidth="min-w-[420px]">
				<thead className={headClass}><tr><Th>{t("tls.col.reason")}</Th><Th right>{t("tls.col.failure")}</Th></tr></thead>
				<tbody className="divide-y divide-neutral-100">
					{stats.failureTypes.map((row) => <tr key={row.resultType}><td className="break-all px-4 py-3 font-mono text-xs">{row.resultType}</td><td className={cell}>{row.failure.toLocaleString()}</td></tr>)}
					{stats.failureTypes.length === 0 && <tr><td colSpan={2} className="px-4 py-8 text-center text-neutral-500">{t("tls.failures.empty")}</td></tr>}
				</tbody>
			</Table>
			<Table title={t("tls.policies.title")} minWidth="min-w-[560px]">
				<thead className={headClass}><tr><Th>{t("tls.col.policy")}</Th><Th>{t("tls.col.mx")}</Th><Th right>{t("tls.col.success")}</Th><Th right>{t("tls.col.failure")}</Th></tr></thead>
				<tbody className="divide-y divide-neutral-100">
					{stats.policies.map((row) => { const key = policyKey(row.policyType); return <tr key={`${row.policyType}|${row.mxHost ?? ""}`}><td className="px-4 py-3">{key ? t(key) : row.policyType}</td><td className="break-all px-4 py-3">{row.mxHost ?? ""}</td><td className={cell}>{row.success.toLocaleString()}</td><td className={cell}>{row.failure.toLocaleString()}</td></tr>; })}
					{stats.policies.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-neutral-500">{t("tls.daily.empty")}</td></tr>}
				</tbody>
			</Table>
			<Table title={t("tls.reporters.title")} minWidth="min-w-[480px]">
				<thead className={headClass}><tr><Th>{t("dmarc.col.reporter")}</Th><Th right>{t("tls.col.success")}</Th><Th right>{t("tls.col.failure")}</Th></tr></thead>
				<tbody className="divide-y divide-neutral-100">
					{stats.reporters.map((row) => <tr key={row.reporterOrg}><td className="break-all px-4 py-3">{row.reporterOrg}</td><td className={cell}>{row.success.toLocaleString()}</td><td className={cell}>{row.failure.toLocaleString()}</td></tr>)}
					{stats.reporters.length === 0 && <tr><td colSpan={3} className="px-4 py-8 text-center text-neutral-500">{t("dmarc.reporters.empty")}</td></tr>}
				</tbody>
			</Table>
			<RecentReports reports={stats.recentReports} />
		</div>}
	</div>;
}
