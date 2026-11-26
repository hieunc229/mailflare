import { createDnsRecord, deleteDnsRecord, listDnsRecords } from "@/lib/cloudflare-dns";
import { isManualZone } from "@/lib/domains/provision";
import { requireAwsConfig } from "@/lib/aws/config";
import { attachSesFeedToIdentity } from "@/lib/deliverability/ses-feed";
import { createSesIdentity, deleteSesIdentity, getSesAccount, getSesIdentity } from "@/lib/aws/ses";
import type { DomainRow } from "@/lib/domains/types";
import type { SesSendingView } from "@/lib/aws/ses-sending-types";

const same = (a: string, b: string) => a.trim().toLowerCase().replace(/\.$/, "") === b.trim().toLowerCase().replace(/\.$/, "");

async function missingRecords(env: CloudflareEnv, domain: DomainRow, records: { name: string; value: string }[]): Promise<number | null> {
	if (isManualZone(domain.zoneId)) return null;
	try {
		const present = await Promise.all(records.map(async (record) => {
			const existing = await listDnsRecords(env, domain.zoneId, { type: "CNAME", name: record.name });
			return existing.some((item) => same(item.content ?? "", record.value));
		}));
		return present.filter((exists) => !exists).length;
	} catch { return null; }
}

async function view(env: CloudflareEnv, domain: DomainRow): Promise<SesSendingView> {
	const config = await requireAwsConfig(env);
	const [identity, account] = await Promise.all([
		getSesIdentity(config, domain.hostname),
		getSesAccount(config).catch(() => null),
	]);
	return {
		registered: identity.registered,
		verified: identity.verified,
		dkimStatus: identity.dkimStatus,
		records: identity.records,
		dnsManaged: !isManualZone(domain.zoneId),
		missingDns: identity.registered ? await missingRecords(env, domain, identity.records) : null,
		productionAccess: account?.productionAccess ?? null,
		region: config.region,
	};
}

export const getSesSendingView = view;

/** Registers the domain identity in SES and publishes its DKIM CNAMEs to the Cloudflare zone. */
export async function setupSesSending(env: CloudflareEnv, domain: DomainRow): Promise<SesSendingView> {
	const config = await requireAwsConfig(env);
	const identity = await createSesIdentity(config, domain.hostname);
	if (!isManualZone(domain.zoneId)) {
		for (const record of identity.records) {
			const existing = await listDnsRecords(env, domain.zoneId, { type: "CNAME", name: record.name });
			if (existing.some((item) => same(item.content ?? "", record.value))) continue;
			await createDnsRecord(env, domain.zoneId, { type: "CNAME", name: record.name, content: record.value, ttl: 3600, proxied: false });
		}
	}
	// Bounce and complaint feed, when enabled: best effort, sending works without it.
	await attachSesFeedToIdentity(env, domain.hostname);
	return view(env, domain);
}

export async function removeSesSending(env: CloudflareEnv, domain: DomainRow): Promise<void> {
	const config = await requireAwsConfig(env);
	const identity = await getSesIdentity(config, domain.hostname);
	if (!isManualZone(domain.zoneId)) {
		for (const record of identity.records) {
			for (const item of await listDnsRecords(env, domain.zoneId, { type: "CNAME", name: record.name })) {
				if (item.id && same(item.content ?? "", record.value)) await deleteDnsRecord(env, domain.zoneId, item.id);
			}
		}
	}
	await deleteSesIdentity(config, domain.hostname);
}
