import { summariseDns, type DnsStatusSummary } from "@/lib/dns-status";
import { auditDomainDns, type DomainDnsAudit } from "@/lib/domains/dns-audit";
import { isInboundMxPublished } from "@/lib/domains/receiving-dns";
import { getDomainDns, type DomainDnsView } from "@/lib/domains/service";
import type { DomainRow } from "@/lib/domains/types";

export type DomainDnsViewWithAudit = DomainDnsView & { audit: DomainDnsAudit };

/** `saved` answers from the last check, when there is one, instead of looking DNS up again. */
type DnsCheckOptions = { saved?: boolean };

/** A saved check stops counting once the zone or a provider changes. */
const settingsKey = (domain: DomainRow) => `${domain.zoneId}:${domain.receivingProvider}:${domain.sendingProvider}`;
const objectKey = (domain: DomainRow, name: "view" | "ready") => `dns-checks/${domain.id}/${name}.json`;

async function readSaved<T>(env: CloudflareEnv, domain: DomainRow, name: "view" | "ready"): Promise<T | null> {
	try {
		const object = await env.BUCKET.get(objectKey(domain, name));
		if (!object) return null;
		const saved = JSON.parse(await object.text()) as { settings: string; value: T };
		return saved.settings === settingsKey(domain) ? saved.value : null;
	} catch (error) {
		console.warn("Failed to read a saved DNS check", error);
		return null;
	}
}

async function save<T>(env: CloudflareEnv, domain: DomainRow, name: "view" | "ready", value: T): Promise<void> {
	try {
		await env.BUCKET.put(objectKey(domain, name), JSON.stringify({ settings: settingsKey(domain), value }));
	} catch (error) {
		console.warn("Failed to save a DNS check", error);
	}
}

/** The DNS page's view: zone records plus an independent public-DNS audit. */
export async function getDomainDnsView(
	env: CloudflareEnv,
	domain: DomainRow,
	options?: DnsCheckOptions,
): Promise<DomainDnsViewWithAudit> {
	if (options?.saved) {
		const saved = await readSaved<DomainDnsViewWithAudit>(env, domain, "view");
		if (saved) return saved;
	}
	const dns = await getDomainDns(env, domain);
	const audit = await auditDomainDns(domain.hostname, dns, domain.sendingProvider);
	const view = { ...dns, audit };
	await save(env, domain, "view", view);
	return view;
}

/** Whether mail for the domain can arrive; null when DNS could not be checked (which is not saved). */
export async function isDomainDnsReady(
	env: CloudflareEnv,
	domain: DomainRow,
	options?: DnsCheckOptions,
): Promise<boolean | null> {
	if (options?.saved) {
		const saved = await readSaved<boolean>(env, domain, "ready");
		if (saved !== null) return saved;
	}
	const ready = await isInboundMxPublished(domain);
	if (ready !== null) await save(env, domain, "ready", ready);
	return ready;
}

/** Records the operator's word that DNS is set, until the next check. */
export async function markDomainDnsReady(env: CloudflareEnv, domain: DomainRow): Promise<void> {
	await save(env, domain, "ready", true);
}

/** The compact per-domain status the list endpoint returns. */
export async function summariseDomainDns(
	env: CloudflareEnv,
	domain: DomainRow,
	options?: DnsCheckOptions,
): Promise<{ summary: DnsStatusSummary; sendingEnabled: boolean }> {
	const view = await getDomainDnsView(env, domain, options);
	return {
		summary: summariseDns(
			view.routing.records,
			view.routing.missing,
			view.sending,
			domain.routingEnabled,
			view.sendingEnabled,
			view.audit,
		),
		sendingEnabled: view.sendingEnabled,
	};
}
