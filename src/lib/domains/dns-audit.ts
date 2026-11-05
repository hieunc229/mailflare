import type { CfDnsRecord } from "@/lib/cloudflare-api.types";
import { queryDns, type DnsQueryType } from "@/lib/dns-query";

export type DnsAuthRecord = "mx" | "spf" | "dkim" | "dmarc";
export type DnsAuthStatus = "ok" | "missing" | "unknown";

export type DnsAuthCheck = {
	record: DnsAuthRecord;
	label: string;
	name: string;
	status: DnsAuthStatus;
	found: string[];
};

export type DomainDnsAudit = {
	mx: DnsAuthCheck;
	spf: DnsAuthCheck;
	dkim: DnsAuthCheck;
	dmarc: DnsAuthCheck;
};

type AuditInput = {
	routing: { records: CfDnsRecord[]; missing: CfDnsRecord[] };
	sending: CfDnsRecord[];
	dkimSelector?: string;
};

function isTxt(record: CfDnsRecord) {
	return record.type?.toUpperCase() === "TXT";
}

async function check(
	record: DnsAuthRecord,
	label: string,
	name: string,
	type: DnsQueryType,
	matches: (value: string) => boolean,
): Promise<DnsAuthCheck> {
	try {
		const answers = await queryDns(name, type);
		const found = answers.filter(matches);
		return { record, label, name, status: found.length > 0 ? "ok" : "missing", found };
	} catch {
		return { record, label, name, status: "unknown", found: [] };
	}
}

/** The first name with a match wins; a failed lookup counts only when nothing else answered. */
async function checkAny(
	record: DnsAuthRecord,
	label: string,
	names: string[],
	type: DnsQueryType,
	matches: (value: string) => boolean,
): Promise<DnsAuthCheck> {
	const results = await Promise.all(names.map((name) => check(record, label, name, type, matches)));
	return results.find((result) => result.status === "ok") ?? results.find((result) => result.status === "unknown") ?? results[0];
}

/**
 * Where a sender's SPF record may live. Resend puts it on its return-path
 * subdomains — `send.<domain>` (a TXT, or a CNAME whose target carries the TXT)
 * and `rsend.<domain>` on newer domains — never on the apex.
 */
function spfNames(hostname: string, sendingProvider?: string): string[] {
	return sendingProvider === "resend" ? [hostname, `send.${hostname}`, `rsend.${hostname}`] : [hostname];
}

/**
 * Independently verifies the public DNS a domain needs, rather than trusting
 * the zone records the Cloudflare API reports. MX and DMARC are checked at
 * their canonical names, SPF at the names the sending provider uses; DKIM uses
 * the selector the sending subdomain was provisioned with. A name that
 * resolves is "ok", one that answers NXDOMAIN is "missing", and a lookup that
 * fails outright is "unknown".
 */
export async function auditDomainDns(
	hostname: string,
	view: AuditInput,
	sendingProvider?: string,
): Promise<DomainDnsAudit> {
	const expected = [...view.routing.records, ...view.routing.missing, ...view.sending];
	// Cloudflare reports the selector it signs with, which is more reliable than
	// guessing from the subdomain's DNS records (whose names may be relative).
	const dkimName =
		(view.dkimSelector
			? `${view.dkimSelector}._domainkey.${hostname}`
			: undefined) ??
		expected.find((record) => isTxt(record) && /_domainkey/i.test(record.name ?? ""))?.name ??
		(sendingProvider === "resend" ? `resend._domainkey.${hostname}` : undefined);

	const [mx, spf, dmarc] = await Promise.all([
		check("mx", "MX", hostname, "MX", (value) => !/^0\s*\.?$/.test(value.trim())),
		checkAny("spf", "SPF", spfNames(hostname, sendingProvider), "TXT", (value) => /v=spf1/i.test(value)),
		check("dmarc", "DMARC", `_dmarc.${hostname}`, "TXT", (value) => /v=DMARC1/i.test(value)),
	]);

	const dkim: DnsAuthCheck = dkimName
		? await check("dkim", "DKIM", dkimName, "TXT", () => true)
		: {
				record: "dkim",
				label: "DKIM",
				name: `*._domainkey.${hostname}`,
				status: "unknown",
				found: [],
			};

	return { mx, spf, dkim, dmarc };
}
