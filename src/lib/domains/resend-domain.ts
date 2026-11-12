import { createDnsRecord, deleteDnsRecord, listDnsRecords } from "@/lib/cloudflare-dns";
import { isManualZone } from "@/lib/domains/provision";
import { getResendKeyStatus, getResendApiKey } from "@/lib/email/outbound-provider";
import { createResendDomain, deleteResendDomain, findResendDomain, getResendDomain, updateResendCapabilities, verifyResendDomain } from "@/lib/email/resend-api";
import { isInboundSmtpMx, isResendInboundMx } from "@/lib/domains/receiving-dns";
import type { ResendDomain, ResendDomainRecord } from "@/lib/email/resend-api-types";
import type { DomainRow } from "@/lib/domains/types";
import type { ResendDomainView } from "@/lib/domains/resend-domain-types";

/** Records for sending only; the apex MX for receiving belongs to the receiving setup. */
const sendingRecords = (records: ResendDomainRecord[] | undefined) => (records ?? []).filter((record) => !(record.type === "MX" && (isInboundSmtpMx(record.value) || isResendInboundMx(record.value))));

function toView(domain: ResendDomain | null, zoneManaged: boolean, missingDns: number | null = null): ResendDomainView {
	return {
		missingDns,
		registered: !!domain,
		status: domain?.status ?? "not_registered",
		records: sendingRecords(domain?.records).map((record) => ({
			record: record.record,
			type: record.type,
			name: record.name,
			value: record.value,
			priority: record.priority ?? null,
			status: record.status ?? "unknown",
		})),
		dnsManaged: zoneManaged,
	};
}

async function requireResendKey(env: CloudflareEnv, _domain?: DomainRow): Promise<string> {
	return getResendApiKey(env);
}

export async function getResendDomainView(env: CloudflareEnv, domain: DomainRow): Promise<ResendDomainView> {
	const apiKey = await requireResendKey(env, domain);
	return viewFor(env, domain, await findResendDomain(apiKey, domain.hostname));
}

async function viewFor(env: CloudflareEnv, domain: DomainRow, resend: ResendDomain | null): Promise<ResendDomainView> {
	return toView(resend, !isManualZone(domain.zoneId), resend ? await countMissingRecords(env, domain, sendingRecords(resend.records)) : null);
}

const stripQuotes = (value: string) => value.replace(/^"|"$/g, "").trim().toLowerCase().replace(/\.$/, "");

/**
 * The domain's status in Resend ("verified", "pending", ... or "not_registered");
 * null when that cannot be checked (no key, or a send-only key).
 */
export async function getResendDomainStatus(env: CloudflareEnv, domain: DomainRow): Promise<string | null> {
	const { apiKey } = await getResendKeyStatus(env);
	if (!apiKey) return null;
	try {
		const resend = await findResendDomain(apiKey, domain.hostname);
		// A domain added only for receiving has no sending setup.
		return !resend || resend.capabilities?.sending === "disabled" ? "not_registered" : resend.status;
	}
	catch { return null; }
}

async function deleteRecordsFromZone(env: CloudflareEnv, domain: DomainRow, records: ResendDomainRecord[]): Promise<void> {
	if (isManualZone(domain.zoneId)) return;
	for (const record of records) {
		const existing = await listDnsRecords(env, domain.zoneId, { type: record.type, name: absoluteName(record, domain.hostname) });
		for (const item of existing) {
			if (item.id && stripQuotes(item.content ?? "") === stripQuotes(record.value)) await deleteDnsRecord(env, domain.zoneId, item.id);
		}
	}
}

/**
 * Removes Resend's sending setup. The Resend domain also carries receiving, so
 * when the domain still receives through Resend only sending is switched off.
 */
export async function removeResendConfig(env: CloudflareEnv, domain: DomainRow): Promise<void> {
	const apiKey = await getResendApiKey(env);
	const resend = await findResendDomain(apiKey, domain.hostname);
	if (!resend) return;
	if (domain.receivingProvider === "resend") {
		await deleteRecordsFromZone(env, domain, sendingRecords(resend.records));
		await updateResendCapabilities(apiKey, resend.id, { sending: false });
		return;
	}
	await deleteRecordsFromZone(env, domain, resend.records ?? []);
	await deleteResendDomain(apiKey, resend.id);
}

/** Resend lists names relative to the domain; Cloudflare needs them absolute. */
function absoluteName(record: ResendDomainRecord, hostname: string): string {
	const name = record.name.trim();
	if (!name || name === "@") return hostname;
	return name.endsWith(`.${hostname}`) || name === hostname ? name : `${name}.${hostname}`;
}

async function recordExists(env: CloudflareEnv, domain: DomainRow, record: ResendDomainRecord): Promise<boolean> {
	const existing = await listDnsRecords(env, domain.zoneId, { type: record.type, name: absoluteName(record, domain.hostname) });
	return existing.some((item) => stripQuotes(item.content ?? "") === stripQuotes(record.value));
}

/** How many of Resend's records are absent from the zone; null when DNS is not ours to read. */
async function countMissingRecords(env: CloudflareEnv, domain: DomainRow, records: ResendDomainRecord[]): Promise<number | null> {
	if (isManualZone(domain.zoneId)) return null;
	try {
		const present = await Promise.all(records.map((record) => recordExists(env, domain, record)));
		return present.filter((exists) => !exists).length;
	} catch { return null; }
}

async function publishRecords(env: CloudflareEnv, domain: DomainRow, records: ResendDomainRecord[]): Promise<void> {
	for (const record of records) {
		if (await recordExists(env, domain, record)) continue;
		const name = absoluteName(record, domain.hostname);
		const ttl = 3600;
		if (record.type === "MX") {
			await createDnsRecord(env, domain.zoneId, { type: "MX", name, content: record.value, priority: record.priority ?? 10, ttl });
		} else if (record.type === "CNAME") {
			await createDnsRecord(env, domain.zoneId, { type: "CNAME", name, content: record.value, ttl, proxied: false });
		} else {
			await createDnsRecord(env, domain.zoneId, { type: "TXT", name, content: record.value, ttl });
		}
	}
}

/**
 * Registers the domain with Resend if needed, writes its DNS records to the
 * Cloudflare zone (when Mailflare manages it) and asks Resend to verify.
 */
export async function setupResendDomain(env: CloudflareEnv, domain: DomainRow): Promise<ResendDomainView> {
	const apiKey = await requireResendKey(env, domain);
	const managed = !isManualZone(domain.zoneId);
	let resend = await findResendDomain(apiKey, domain.hostname);
	if (!resend) {
		const created = await createResendDomain(apiKey, domain.hostname, { sending: true, receiving: domain.receivingProvider === "resend" });
		resend = await getResendDomain(apiKey, created.id);
	} else if (resend.capabilities?.sending === "disabled") {
		// The domain was added for receiving only; sending needs its own DKIM and SPF.
		await updateResendCapabilities(apiKey, resend.id, { sending: true });
		resend = await getResendDomain(apiKey, resend.id);
	}
	if (managed) await publishRecords(env, domain, sendingRecords(resend.records));
	await verifyResendDomain(apiKey, resend.id);
	return viewFor(env, domain, await getResendDomain(apiKey, resend.id));
}

export async function verifyResendDomainView(env: CloudflareEnv, domain: DomainRow): Promise<ResendDomainView> {
	const apiKey = await requireResendKey(env, domain);
	const resend = await findResendDomain(apiKey, domain.hostname);
	if (!resend) return viewFor(env, domain, null);
	await verifyResendDomain(apiKey, resend.id);
	return viewFor(env, domain, await getResendDomain(apiKey, resend.id));
}
