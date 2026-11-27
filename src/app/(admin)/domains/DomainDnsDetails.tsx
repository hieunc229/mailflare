import { useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { dnsAuthDescriptions, getDnsAuthItemClass } from "./utils";
import { ROW_GRID, StatusBadge, StatusRow } from "./status-row";
import CloudflareReceivingConfig from "./CloudflareReceivingConfig";
import ReceivingSetupSection from "./ReceivingSetupSection";
import SendingSetupSection from "./SendingSetupSection";
import TrackingHostSection from "./TrackingHostSection";
import type { DnsAuthRecord, DomainDnsDetailsProps } from "./types";

export default function DomainDnsDetails({
	domain,
	dns,
	onSetup,
	setupRecord,
	setupMessage,
	onSendingProviderChange,
	sendingProviderBusy,
	sendingProviderMessage,
	onReceivingProviderChange,
	receivingProviderBusy,
	receivingProviderMessage,
	onDnsChanged,
	managesDns = true,
}: DomainDnsDetailsProps) {
	const { t } = useLanguage();
	const audit = dns.audit;
	const [rechecking, setRechecking] = useState(false);
	async function recheck() {
		setRechecking(true);
		try { await onDnsChanged?.(); } finally { setRechecking(false); }
	}
	const manual = domain.zoneId === "manual" && !domain.dnsSkipped;
	// Nothing can create records for these, so list them instead of offering a setup button.
	const byHand = domain.zoneId === "manual" && (!domain.dnsSkipped || !managesDns);
	const manualRecords = domain.zoneId === "manual" ? dns.routing.missing : [];
	const subdomain = dns.sendingSubdomain;
	const sendingOk = subdomain ? dns.sendingEnabled : manual && domain.sendingEnabled;
	const sendingLabel = subdomain
		? t("domains.sendingFor", { name: subdomain.name, state: dns.sendingEnabled ? t("domains.enabled") : t("domains.disabled") })
		: manual
			? domain.sendingEnabled
				? t("domains.sendingConfigured")
				: t("domains.sendingNotConfigured")
			: t("domains.sendingNotSet");
	const routingOk = dns.routing.missing.length === 0 && (dns.routing.records.length > 0 || domain.routingEnabled);
	const routingLabel = routingOk
		? t("domains.routingConfigured")
		: dns.routing.missing.length > 0
			? t("domains.recordsMissing", { count: dns.routing.missing.length })
			: t("domains.noRoutingRecords");

	const auditRow = (record: DnsAuthRecord) => {
		if (!audit) return null;
		const item = audit[record];
		const ok = item.status === "ok";
		return (
			<li key={record} className={`${ROW_GRID} ${getDnsAuthItemClass(item.status)}`}>
				<StatusBadge ok={ok} tone={item.status === "missing" ? "red" : "neutral"} />
				<span className="min-w-0">
					<span className="block font-medium text-neutral-900">{t("domains.recordLabel", { label: item.label })}</span>
					<span className="block text-xs text-neutral-500">{t(dnsAuthDescriptions[record])}</span>
				</span>
				{ok ? (
					<span className="min-w-0 break-all text-neutral-500">{item.found.length > 0 ? item.found.join(", ") : item.name}</span>
				) : byHand ? (
					<span className="min-w-0 break-all text-neutral-500">{item.name}</span>
				) : (
					<Button
						variant="outline"
						size="sm"
						className="shrink-0 bg-white"
						disabled={setupRecord === record}
						title={t("domains.createRecord", { label: item.label })}
						onClick={() => onSetup?.(record)}
					>
						{setupRecord === record ? t("domains.settingUp") : t("domains.setup")}
					</Button>
				)}
			</li>
		);
	};

	const cloudflareConfig = (
		<ul className="space-y-2">
			<StatusRow ok={!!sendingOk} title={t("domains.emailSending")} hint={t("domains.emailSendingHint")}>{sendingLabel}</StatusRow>
			{auditRow("dkim")}
		</ul>
	);

	const cloudflareReceiving = (
		<CloudflareReceivingConfig domainId={domain.id} routingOk={routingOk} routingLabel={routingLabel} manual={byHand} onChanged={onDnsChanged} />
	);

	return (
		<div className="px-4 pb-4 pt-4 sm:px-5 sm:pb-5">
			{audit && (
				<section>
					<div className="flex items-center justify-between gap-3">
						<h2 className="text-base font-semibold text-neutral-900">{t("domains.setupTitle")}</h2>
						<Button variant="outline" size="sm" disabled={rechecking} onClick={() => void recheck()}>
							{rechecking ? t("domains.checking") : t("domains.recheckDns")}
						</Button>
					</div>
					<p className="mt-0.5 text-sm text-neutral-500">
						{t("domains.setupDescription")}
					</p>
					<ul className="mt-3 space-y-2">
						{(["mx", "spf", "dmarc"] as DnsAuthRecord[]).map(auditRow)}
					</ul>
					{byHand && (
						<p className="mt-3 text-xs text-neutral-500">
							{t("domains.manualDnsNote")}
						</p>
					)}
					{manualRecords.length > 0 && (
						<ul className="mt-2 space-y-1 text-xs text-neutral-600">
							{manualRecords.map((record) => (
								<li key={`${record.type}-${record.name}-${record.content}`} className="grid gap-1 rounded-lg bg-neutral-50 px-3 py-2 sm:grid-cols-[4rem_minmax(8rem,14rem)_minmax(0,1fr)]">
									<span className="font-medium">{record.type}</span>
									<span className="break-all">{record.name}</span>
									<span className="break-all">{record.content}</span>
								</li>
							))}
						</ul>
					)}
					{setupMessage && <p role="alert" className="text-xs text-red-600">{setupMessage}</p>}
				</section>
			)}
			<ReceivingSetupSection
				domain={domain}
				onChange={onReceivingProviderChange}
				busy={receivingProviderBusy}
				message={receivingProviderMessage}
				cloudflareConfig={cloudflareReceiving}
				cloudflareOk={routingOk}
			/>
			<SendingSetupSection
				domain={domain}
				onChange={onSendingProviderChange}
				busy={sendingProviderBusy}
				message={sendingProviderMessage}
				cloudflareConfig={cloudflareConfig}
				cloudflareOk={!!sendingOk && audit?.dkim.status === "ok"}
			/>
			{domain.sendingProvider !== "none" && <TrackingHostSection domain={domain} />}
		</div>
	);
}
