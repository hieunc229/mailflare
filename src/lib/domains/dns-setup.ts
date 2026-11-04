import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains } from "@/db/schema";
import { enableEmailRouting, getZone } from "@/lib/cloudflare-api";
import { createDnsRecord, listDnsRecords } from "@/lib/cloudflare-dns";
import { ensureEmailRoutingCatchAllToWorker } from "@/lib/domains/catch-all-routing";
import type { DnsAuthRecord } from "@/lib/domains/dns-audit";
import {
	isManualZone,
	shouldBindEmailCatchAllToWorker,
} from "@/lib/domains/provision";
import { ensureSendingSubdomain } from "@/lib/domains/sending-subdomain";
import type { DomainRow } from "@/lib/domains/types";
import { isZoneApex } from "@/lib/domains/utils";

/**
 * Provisions the DNS a single authentication check is missing, reusing the same
 * mechanisms domain creation uses: MX/SPF come from enabling Email Routing,
 * DKIM from a sending subdomain, and DMARC is a hand-written TXT since
 * Cloudflare does not create one for the domain. Idempotent, so a click on a
 * record that already exists is a no-op. DKIM throws MxConflictError when another
 * service's MX records block the sending subdomain, unless `replaceMx` is set.
 */
export async function setupDomainDnsRecord(
	env: CloudflareEnv,
	domain: DomainRow,
	record: DnsAuthRecord,
	options: { replaceMx?: boolean } = {},
): Promise<void> {
	if (isManualZone(domain.zoneId)) {
		throw new Error("DNS for this domain is managed manually");
	}

	switch (record) {
		case "mx":
		case "spf": {
			const zone = await getZone(env, domain.zoneId);
			const routingName = isZoneApex(domain.hostname, zone.name) ? undefined : domain.hostname;
			const result = await enableEmailRouting(env, domain.zoneId, routingName);
			if (shouldBindEmailCatchAllToWorker(env)) {
				await ensureEmailRoutingCatchAllToWorker(env, domain.zoneId);
			}
			const routingEnabled = result.enabled ?? true;
			await getDb(env)
				.update(domains)
				.set({
					routingEnabled,
					routingStatus: result.status ?? domain.routingStatus,
					// A domain added with "Skip DNS setup" starts out pending, and inbound
					// routing only resolves active domains, so turning on receiving here
					// has to activate it the same way domain creation does.
					...(routingEnabled ? { status: "active" as const } : {}),
				})
				.where(eq(domains.id, domain.id));
			return;
		}
		case "dkim": {
			// The stored tag can be stale or empty even though the subdomain exists
			// on Cloudflare, so reuse what is there instead of creating a duplicate
			// (which Cloudflare rejects with "Subdomain already exists").
			const { subdomain } = await ensureSendingSubdomain(env, domain.zoneId, domain.hostname, {
				replaceMx: options.replaceMx,
			});
			await getDb(env)
				.update(domains)
				.set({
					sendingSubdomainTag: subdomain.tag,
					sendingEnabled: subdomain.enabled,
					sendingRequested: true,
					...(subdomain.enabled ? { status: "active" as const } : {}),
				})
				.where(eq(domains.id, domain.id));
			return;
		}
		case "dmarc": {
			const name = `_dmarc.${domain.hostname}`;
			const existing = await listDnsRecords(env, domain.zoneId, { type: "TXT", name });
			if (existing.some((item) => /v=dmarc1/i.test(item.content ?? ""))) return;
			await createDnsRecord(env, domain.zoneId, {
				type: "TXT",
				name,
				content: "v=DMARC1; p=none",
				ttl: 3600,
			});
			return;
		}
	}
}
