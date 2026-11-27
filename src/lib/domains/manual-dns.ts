import type { DomainDnsView } from "@/lib/domains/service";
import { isVercelRuntime } from "@/lib/runtime";

/**
 * The DNS a self-hosted install needs when Mailflare is not managing the
 * zone. Rendered as "missing" until the operator confirms, since the app
 * cannot read their DNS; the records are what the SMTP listener and an
 * SMTP relay expect. Vercel has no mail listener, so only DMARC is listed there:
 * MX and SPF come from the receiving and sending providers.
 */
export async function getManualDomainDns(env: CloudflareEnv, hostname: string): Promise<DomainDnsView> {
	const mailHost = process.env.MAIL_HOSTNAME?.trim() || `mail.${hostname}`;
	const mailHostRecords = [
		{ type: "MX", name: hostname, content: `10 ${mailHost}`, ttl: 3600 },
		{ type: "TXT", name: hostname, content: `v=spf1 a:${mailHost} ~all`, ttl: 3600 },
	];
	const records = [
		...(isVercelRuntime(env) ? [] : mailHostRecords),
		{ type: "TXT", name: `_dmarc.${hostname}`, content: "v=DMARC1; p=none", ttl: 3600 },
	];
	const mailer = env.EMAIL as unknown as { configured?: boolean };
	return {
		routing: { records: [], missing: records, status: "manual" },
		sending: [],
		sendingEnabled: mailer?.configured === true,
	};
}
