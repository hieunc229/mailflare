import { queryDns } from "@/lib/dns-query";
import { createDnsRecord, deleteDnsRecord, listMxRecords } from "@/lib/cloudflare-dns";
import { isManualZone } from "@/lib/domains/provision";
import type { CfDnsRecord } from "@/lib/cloudflare-api.types";
import type { DomainRow } from "@/lib/domains/types";

/** Thrown when other mail servers' MX records would shadow the one being added. */
export class MxConflictError extends Error {
	readonly code = "MX_CONFLICT";
	constructor(
		readonly records: { content: string; priority: number }[],
		message = "This domain has MX records for another mail service. Replace them to receive mail here.",
	) {
		super(message);
	}
}

const same = (a: string, b: string) => a.trim().toLowerCase().replace(/\.$/, "") === b.trim().toLowerCase().replace(/\.$/, "");

export async function listDomainMx(env: CloudflareEnv, domain: DomainRow): Promise<CfDnsRecord[]> {
	if (isManualZone(domain.zoneId)) return [];
	return listMxRecords(env, domain.zoneId, domain.hostname);
}

async function hasPublicMx(hostname: string, matches: (target: string) => boolean): Promise<boolean | null> {
	try {
		const answers = await queryDns(hostname, "MX");
		return answers.some((answer) => matches(answer.replace(/^\d+\s+/, "")));
	} catch {
		return null;
	}
}

/** Whether an MX record for `content` is in the zone, or in public DNS when the zone is manual; null when it cannot be checked. */
export async function hasMx(env: CloudflareEnv, domain: DomainRow, content: string): Promise<boolean | null> {
	return hasMxMatching(env, domain, (target) => same(target, content));
}

/** Whether any MX matching `matches` is published — for providers that accept a shape of target rather than one exact host. */
export async function hasMxMatching(env: CloudflareEnv, domain: DomainRow, matches: (target: string) => boolean): Promise<boolean | null> {
	if (isManualZone(domain.zoneId)) return hasPublicMx(domain.hostname, matches);
	return (await listDomainMx(env, domain)).some((record) => matches(record.content ?? ""));
}

/**
 * Points the domain's MX at `content`. Any other MX record is a conflict (mail
 * goes to the lowest priority), so without `replace` this throws and nothing changes.
 * Returns the records it deleted.
 */
export async function publishMx(
	env: CloudflareEnv,
	domain: DomainRow,
	content: string,
	options: { replace: boolean; priority?: number },
): Promise<CfDnsRecord[]> {
	if (isManualZone(domain.zoneId)) return [];
	const existing = await listDomainMx(env, domain);
	const others = existing.filter((record) => !same(record.content ?? "", content));
	if (others.length > 0 && !options.replace) {
		throw new MxConflictError(others.map((record) => ({ content: record.content ?? "", priority: record.priority ?? 0 })));
	}
	// Create the new record first: if it is rejected nothing has been deleted, so the
	// domain keeps receiving mail where it did.
	if (!existing.some((record) => same(record.content ?? "", content))) {
		await createDnsRecord(env, domain.zoneId, { type: "MX", name: domain.hostname, content, priority: options.priority ?? 10, ttl: 3600 });
	}
	for (const record of others) if (record.id) await deleteDnsRecord(env, domain.zoneId, record.id);
	return others;
}

export async function removeMx(env: CloudflareEnv, domain: DomainRow, matches: (content: string) => boolean): Promise<void> {
	if (isManualZone(domain.zoneId)) return;
	for (const record of await listDomainMx(env, domain)) {
		if (record.id && matches(record.content ?? "")) await deleteDnsRecord(env, domain.zoneId, record.id);
	}
}

export const isInboundSmtpMx = (content: string) => /inbound-smtp\.[a-z0-9-]+\.amazonaws\.com\.?$/i.test(content.trim());

/** Resend inbound MX: the SES-style host, or the newer `receive[-<region>].forge.rmta.net` host. */
export const isResendInboundMx = (content: string) =>
	isInboundSmtpMx(content) || /^receive(-[a-z0-9-]+)?\.forge\.rmta\.net\.?$/i.test(content.trim());

/**
 * Whether public DNS sends this domain's mail to its receiving service; null when it cannot be checked. With no
 * service selected, or on a manual zone left on the Cloudflare default, the self-hosted mail host, Cloudflare's
 * relay, Resend and SES all count.
 */
export async function isInboundMxPublished(domain: Pick<DomainRow, "hostname" | "receivingProvider" | "zoneId">): Promise<boolean | null> {
	const mailHost = process.env.MAIL_HOSTNAME?.trim() || `mail.${domain.hostname}`;
	const isCloudflare = (target: string) => /\.mx\.cloudflare\.net\.?$/i.test(target.trim());
	const isAny = (target: string) => same(target, mailHost) || isCloudflare(target) || isResendInboundMx(target);
	const matchers = {
		cloudflare: isManualZone(domain.zoneId) ? isAny : isCloudflare,
		resend: isResendInboundMx,
		ses: isInboundSmtpMx,
		none: isAny,
	};
	return hasPublicMx(domain.hostname, matchers[domain.receivingProvider]);
}
